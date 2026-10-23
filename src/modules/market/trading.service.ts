import { Prisma, TradeResult } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notify, usd } from '../../lib/notify.js';
import { balanceOf, postEntry } from '../wallet/ledger.js';

const D = Prisma.Decimal;
const DAILY_TRADE_LIMIT = 1;

/**
 * Generates a randomized outcome with +20% to +45% wins and capped -5% to -15% losses.
 */
function nextTradeOutcome() {
  const result = Math.random() < 0.5 ? TradeResult.WIN : TradeResult.LOSS;
  const profitRate = result === TradeResult.WIN
    ? new D((Math.random() * (0.45 - 0.20) + 0.20).toFixed(4))
    : new D((Math.random() * (0.15 - 0.05) + 0.05).toFixed(4)).negated();

  return { result, profitRate };
}

export async function executeScheduledMentorTrade(mentorId: string) {
  const mentor = await prisma.mentor.findUnique({
    where: { id: mentorId },
    select: {
      id: true,
      userId: true,
      displayName: true,
      user: { select: { name: true } },
    },
  });
  if (!mentor) throw new Error('MENTOR_NOT_FOUND');
  const mentorName = mentor.displayName ?? mentor.user.name;

  const notifications = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${mentor.userId} FOR UPDATE`;

    const allocations = await tx.copyRelation.findMany({
      where: { mentorId: mentor.id, status: 'ACTIVE' },
      include: { account: { select: { userId: true } } },
    });
    if (!allocations.length) return [];

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const tradesTodayCount = await tx.trade.count({
      where: { mentorId: mentor.userId, createdAt: { gte: startOfDay } },
    });

    if (tradesTodayCount >= DAILY_TRADE_LIMIT) {
      console.info(`Daily trade limit of ${DAILY_TRADE_LIMIT} reached for mentor ${mentorId}.`);
      return [];
    }

    const outcome = nextTradeOutcome();

    const trade = await tx.trade.create({
      data: {
        mentorId: mentor.userId,
        result: outcome.result,
        profitRate: outcome.profitRate,
      },
    });

    const messages: { userId: string; title: string; body: string; rows: [string, string][] }[] = [];
    for (const allocation of allocations) {
      const pnlAmount = BigInt(
        new D(allocation.allocationMinor.toString())
          .mul(outcome.profitRate)
          .toDecimalPlaces(0, D.ROUND_HALF_UP)
          .toFixed(0),
      );
      const accountId = allocation.accountId;

      await postEntry(tx, {
        accountId,
        amount: pnlAmount,
        type: 'TRADE_PNL',
        key: `mentor-trade:${trade.id}:${accountId}`,
        refType: 'Trade',
        refId: trade.id,
      });

      const balanceAfter = await balanceOf(accountId, tx);
      await tx.tradeExecution.create({
        data: {
          tradeId: trade.id,
          menteeId: allocation.account.userId,
          allocatedAmount: allocation.allocationMinor,
          pnlAmount,
          balanceAfter,
        },
      });

      const isWin = outcome.result === TradeResult.WIN;
      const status = isWin ? 'PROFIT' : 'LOSS';
      const formattedPnlStr = `${pnlAmount >= 0n ? '+' : '-'}$${usd(pnlAmount < 0n ? -pnlAmount : pnlAmount)}`;
      const percentageStr = `${outcome.profitRate.mul(100).toFixed(2)}%`;

      messages.push({
        userId: allocation.account.userId,
        title: `High-margin trade update: ${status}`,
        body: `Your mirrored trade from ${mentorName} closed with ${status.toLowerCase()} of ${formattedPnlStr} (${percentageStr}).`,
        rows: [
          ['Mentor', mentorName],
          ['Result', status],
          ['Profit / loss', formattedPnlStr],
          ['Return rate', percentageStr],
          ['Allocated', `$${usd(allocation.allocationMinor)}`],
          ['Balance', `$${usd(balanceAfter)}`],
        ],
      });
    }
    return messages;
  });

  for (const message of notifications) {
    void notify(message.userId, message.title, message.body, true, message.rows)
      .catch((error) => console.error('Failed to send mentor trade notification', error));
  }

  if (notifications.length) {
    console.info(`Executed randomized trade for mentor ${mentorId}.`);
  }
}
