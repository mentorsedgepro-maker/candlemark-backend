import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { processDynamicDepositBridge } from "./index.js";

const createBody = z.object({
  assetType: z.enum(["EVM", "SOLANA"]),
  refundAddress: z.string().trim().min(20).max(100),
});
const idempotencyHeader = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

const publicOrder = (order: {
  id: string;
  assetType: "EVM" | "SOLANA";
  depositAddress: string;
  status: string;
  sourceTxHash: string | null;
  moneroTxHash: string | null;
  payoutTxHash: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: order.id,
  assetType: order.assetType,
  depositAddress: order.depositAddress,
  status: order.status,
  sourceTxHash: order.sourceTxHash,
  moneroTxHash: order.moneroTxHash,
  payoutTxHash: order.payoutTxHash,
  error: order.lastError,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

export const bridgeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.auth);

  app.post("/", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { assetType, refundAddress } = createBody.parse(req.body);
    const clientKey = idempotencyHeader.parse(req.headers["idempotency-key"]);
    const idempotencyKey = `bridge:${req.user.sub}:${clientKey}`;
    const existing = await prisma.bridgeOrder.findUnique({ where: { idempotencyKey } });
    if (existing) return reply.send(publicOrder(existing));

    const created = await processDynamicDepositBridge(req.user.sub, assetType, refundAddress, idempotencyKey);
    const order = await prisma.bridgeOrder.findUniqueOrThrow({ where: { id: created.id } });
    return reply.code(201).send(publicOrder(order));
  });

  app.get("/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const order = await prisma.bridgeOrder.findFirst({ where: { id, userId: req.user.sub } });
    if (!order) return reply.code(404).send({ error: "BRIDGE_ORDER_NOT_FOUND" });
    return publicOrder(order);
  });

  app.get("/", async (req) => {
    const orders = await prisma.bridgeOrder.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    return { items: orders.map(publicOrder) };
  });
};
