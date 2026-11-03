import express from "express";
import router from "./routers/client.js";
const app = express(); app.use("/v1/otc", router);
