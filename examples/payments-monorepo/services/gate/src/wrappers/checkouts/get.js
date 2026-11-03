import prisma from "@acme/prisma";
export default async function get({ id }) { return { success: true, data: await prisma.checkout.findFirst({ where: { id } }) }; }
