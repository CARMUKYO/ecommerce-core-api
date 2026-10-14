import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = buildApp({
  logger: {
    level: env.NODE_ENV === "development" ? "debug" : "info",
  },
});

async function main() {
  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    console.log(`Server listening on port ${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
