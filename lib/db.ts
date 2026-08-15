import { PrismaClient } from "@prisma/client";

// Prisma ORM — the typed query layer. DDL stays SQL-owned (db/migrations/*.sql,
// auto-applied on dev start) because Prisma can't manage pgvector columns.
// Hot-reload-safe singleton: Next.js dev re-imports modules on every change.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
