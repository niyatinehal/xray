import prisma from "@acme/prisma";
import { addTransactionJob } from "../../jobs/transactions.js";
export default async function create({ checkoutId, amount }) {
  const tx = await prisma.transaction.create({ data: { checkoutId, amount } });
  await addTransactionJob({ id: tx.id });
  return { success: true, data: tx };
}
