function timestamp() {
  return new Date().toISOString();
}

function formatData(data) {
  if (data === undefined) return '';
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function logCallback(channel, stage, message, data) {
  const prefix = `[${timestamp()}] [${channel}] [${stage}]`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, formatData(data));
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function logCallbackError(channel, stage, message, data) {
  const prefix = `[${timestamp()}] [${channel}] [${stage}]`;
  if (data !== undefined) {
    console.error(`${prefix} ${message}`, formatData(data));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

module.exports = { logCallback, logCallbackError };
