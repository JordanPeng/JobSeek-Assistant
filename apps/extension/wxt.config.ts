import { defineConfig } from "wxt";

const e2eFixtureOrigins = (
  process.env.JOBSEEK_E2E_HOST ??
  "http://127.0.0.1:41731/*,http://127.0.0.1:41732/*"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const isE2eBuild = process.env.JOBSEEK_E2E === "1";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "JobSeek Assistant",
    description: "Local-only reviewed job application autofill and tracking.",
    version: "0.1.0",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmraT2orcdm4ET91T8I1v4fgzaL0GMPZUtuoe5zMSI+d/WrraoyPcotBPF9C6UiaSAyYm3l/WjMAiYW98WxbQW2cxnaIIbAWQbOtoZdct2vSdX75QWyWT6qDOmJcbvDwdyS8RCz0x7b9vJr6bnBcaPMzHZ087IZALzgDIGrYDPuf4gxs+rPAng7NgOf1U2hSl8vRn8tZrOH6cHyFy+nOecsK66AEuY/UKmqNzYRsCtYWa6ZlDcFweq5B8wAqru3X+9f0WGeHBO4PwikQ325Mlr4zqRvCeCC/qIGgY1/JjOyIEaFq0op0xdlIyw4HT07ODrpB4qSddTaAIfUSInq0AZQIDAQAB",
    permissions: [
      "activeTab",
      "alarms",
      "nativeMessaging",
      "scripting",
      "storage",
    ],
    ...(isE2eBuild ? { host_permissions: e2eFixtureOrigins } : {}),
    optional_host_permissions: ["https://*/*"],
    action: {
      default_title: "JobSeek Assistant",
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
