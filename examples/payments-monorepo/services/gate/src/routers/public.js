import { Router } from "express";
import webhook from "../controllers/checkouts/webhook.js";
const router = Router();
router.post("/webhooks/payment", webhook);
export default router;
