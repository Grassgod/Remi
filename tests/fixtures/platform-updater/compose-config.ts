export const validComposeConfigResult = {
  exitCode: 0,
  stdout: JSON.stringify({ services: {
    api: { healthcheck: { test: ["CMD", "probe"], start_period: "360s" } },
    "api-runtime": { healthcheck: { test: ["CMD", "probe"], start_period: "360s" } },
  } }),
  stderr: "",
};
