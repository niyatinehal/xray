export const createCheckout = (body) => fetch(`${process.env.NEXT_PUBLIC_GATE_URL}/v1/checkouts`, { method: "POST", body: JSON.stringify(body) });
export const createDeposit = (body) => fetch(`${process.env.NEXT_PUBLIC_WALLET_URL}/v1/deposits`, { method: "POST", body: JSON.stringify(body) });
