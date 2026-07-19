import { McpWrapperApplication } from './McpWrapperApplication.js';

const app = new McpWrapperApplication();

async function shutdown(signal) {
  try {
    await app.stop();
  } catch (err) {
    console.error('Shutdown error:', err);
    process.exitCode = 1;
  }
  process.exit();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
