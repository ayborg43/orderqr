// Vercel serverless entry: every /api/* request is handled by the same app
// logic that `npm start` serves locally (see server.js). Vercel treats
// `public/` as static output, so the Node server never runs there without
// this function.
import handler from "../server.js";

export default handler;
