import { Router } from "express";
import accept from "../controllers/quotes/accept.js";
const router = Router();
router.post("/quotes/:id/accept", accept);
export default router;
