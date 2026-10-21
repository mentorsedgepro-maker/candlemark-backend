import { Prisma, TradeResult } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { notify, usd } from '../../lib/notify.js';
import { balanceOf, postEntry } from '../wallet/ledger.js';

const D = Prisma.Decimal;
const WIN_RATE = new D('0.04');
const LOSS_RATE = new D('-0.02');
const DAILY_TRADE_LIMIT = 3;

function nextTradeOutcome(trades: { result: TradeResult }[]) {
  if (trades.length >= DAILY_TRADE_LIMIT) return null;

  const result = trades.length < 2 ? TradeResult.WIN : TradeResult.LOSS;
  return {
    result,
    profitRate: result === TradeResult.WIN ? WIN_RATE : LOSS_RATE,
  };
}

export async function executeScheduledMentorTrade(mentorId: string) {
  const mentor = await prisma.mentor.findUnique({
    where: { id: mentorId },
    select: { id: true, userId: true },
  });
  if (!mentor) throw new Error('MENTOR_NOT_FOUND');

  const notifications = await prisma.$transaction(async (tx) => {
    const allocations = await tx.copyRelation.findMany({
      where: { mentorId: mentor.id, status: 'ACTIVE' },
      include: { account: { select: { userId: true } } },
    });
    if (!allocations.length) return [];

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const tradesToday = await tx.trade.findMany({
      where: { mentorId: mentor.userId, createdAt: { gte: startOfDay } },
      select: { result: true },
    });
    const outcome = nextTradeOutcome(tradesToday);
    if (!outcome) return [];

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

      const status = outcome.result === TradeResult.WIN ? 'PROFIT' : 'LOSS';
      messages.push({
        userId: allocation.account.userId,
        title: `Trade update: ${status}`,
        body: `Your mirrored trade closed with ${status.toLowerCase()} of $${usd(pnlAmount)}.`,
        rows: [
          ['Result', status],
          ['Profit / loss', `$${usd(pnlAmount)}`],
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
}
