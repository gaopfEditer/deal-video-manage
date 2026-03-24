#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

const CONFIG = {
  descriptionsFile: process.env.DESCRIPTIONS_FILE || "descriptions.txt",
  outputDir: process.env.OUTPUT_DIR || "generated_videos",
  aiStudioUrl: process.env.AI_STUDIO_VIDEO_URL || "https://aistudio.google.com/generate-video",
  // 这里只做期望值记录，真实模型以网页 UI 实际显示为准。
  expectedModelName: process.env.EXPECTED_MODEL_NAME || "veo-3.1-generate-preview",
  concurrent: clampInt(process.env.CONCURRENT_VIDEOS, 1, 2, 1),
  pollIntervalMs: clampInt(process.env.POLL_INTERVAL_MS, 1_000, 30_000, 5_000),
  maxWaitMs: clampInt(process.env.MAX_WAIT_MS, 60_000, 30 * 60_000, 12 * 60_000),
  waitAfterGenerateMs: clampInt(process.env.WAIT_AFTER_GENERATE_MS, 30_000, 10 * 60_000, 180_000),
  cdpUrl: process.env.CDP_URL || "http://localhost:9222",
  cdpWsEndpoint: process.env.CDP_WS_ENDPOINT || "",
  promptSelector:
    process.env.PROMPT_SELECTOR ||
    'textarea[placeholder*="Describe"], textarea, div[contenteditable="true"]',
  generateButtonSelector:
    process.env.GENERATE_BUTTON_SELECTOR ||
    'button:has-text("Generate"), button:has-text("Create"), button:has-text("生成")',
  doneIndicatorSelector:
    process.env.DONE_INDICATOR_SELECTOR ||
    'button:has-text("Download"), a:has-text("Download"), button:has-text("下载"), a:has-text("下载")',
  downloadButtonSelector:
    process.env.DOWNLOAD_BUTTON_SELECTOR ||
    'button:has-text("Download"), a:has-text("Download"), button:has-text("下载"), a:has-text("下载")',
  maxNavigateRetry: clampInt(process.env.MAX_NAVIGATE_RETRY, 1, 5, 3),
};

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(input, index) {
  const base = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 48);
  return `${String(index + 1).padStart(3, "0")}_${base || "video"}.mp4`;
}

async function readDescriptions(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`描述文件为空: ${filePath}`);
  }
  return lines;
}

async function connectChrome(cdpUrl) {
  if (CONFIG.cdpWsEndpoint) {
    const wsEndpoint = await normalizeWsEndpoint(CONFIG.cdpWsEndpoint, cdpUrl);
    const browser = await chromium.connectOverCDP(wsEndpoint);
    const contextCount = browser.contexts().length;
    console.log(`[CDP] 已通过 WS 连接 Chrome: ${wsEndpoint} (contexts=${contextCount})`);
    return browser;
  }

  try {
    // 先探测 /json/version，优先拿 ws://... 端点连接，避免部分环境下 browserURL 400。
    const versionUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
    let wsEndpoint = "";
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        const json = await response.json();
        wsEndpoint = json.webSocketDebuggerUrl || "";
      }
    } catch {
      // 探测失败时回退到原始 browserURL 连接逻辑
    }

    const browser = wsEndpoint
      ? await chromium.connectOverCDP(wsEndpoint)
      : await chromium.connectOverCDP(cdpUrl);
    const contextCount = browser.contexts().length;
    console.log(
      `[CDP] 已连接 Chrome: ${wsEndpoint || cdpUrl} (contexts=${contextCount})`
    );
    return browser;
  } catch (error) {
    throw new Error(
      `[CDP] 连接失败。请确认端口未被其他程序占用，或直接设置 CDP_WS_ENDPOINT=ws://localhost:9222/devtools/browser/<id>。${error.message}`
    );
  }
}

async function normalizeWsEndpoint(wsEndpoint, cdpUrl) {
  if (!wsEndpoint.includes("/devtools/page/")) {
    return wsEndpoint;
  }
  console.warn("[WARN] 检测到 page 级 WS 端点，自动切换为 browser 级端点");
  const versionUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`无法从 ${versionUrl} 获取 browser 级 WS 端点`);
  }
  const json = await response.json();
  if (!json.webSocketDebuggerUrl) {
    throw new Error("json/version 未返回 webSocketDebuggerUrl");
  }
  return json.webSocketDebuggerUrl;
}

async function fillPromptAndGenerate(page, description) {
  if (CONFIG.expectedModelName) {
    const modelLabel = page.locator(`text=${CONFIG.expectedModelName}`).first();
    if ((await modelLabel.count()) === 0) {
      console.warn(`[WARN] 页面未检测到模型标识: ${CONFIG.expectedModelName}`);
    }
  }

  const promptEl = page.locator(CONFIG.promptSelector).first();
  await promptEl.waitFor({ state: "visible", timeout: 30_000 });
  await promptEl.click();
  await promptEl.fill(description);

  const generateBtn = page.locator(CONFIG.generateButtonSelector).first();
  await generateBtn.waitFor({ state: "visible", timeout: 10_000 });
  await generateBtn.click();
}

async function waitForVideoReady(page, { intervalMs, maxWaitMs }) {
  const start = Date.now();
  while (true) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`视频生成超时（>${maxWaitMs}ms）`);
    }

    const failedHint = page.locator('text=/failed|error|错误|失败/i');
    if ((await failedHint.count()) > 0) {
      throw new Error("页面显示生成失败，请检查账号权限或 prompt 内容");
    }

    const doneNode = page.locator(CONFIG.doneIndicatorSelector).first();
    if ((await doneNode.count()) > 0) {
      return;
    }
    await sleep(intervalMs);
  }
}

async function triggerDownload(page, outputPath) {
  const downloadNode = page.locator(CONFIG.downloadButtonSelector).first();
  await downloadNode.waitFor({ state: "visible", timeout: 30_000 });

  const href = await downloadNode.getAttribute("href");
  if (href && /^https?:\/\//i.test(href)) {
    const response = await fetch(href);
    if (!response.ok) {
      throw new Error(`下载链接请求失败: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);
    return;
  }

  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20_000 }),
      downloadNode.click(),
    ]);
    await download.saveAs(outputPath);
  } catch {
    throw new Error("未捕获到下载事件，建议检查 DOWNLOAD_BUTTON_SELECTOR");
  }
}

async function runWithRetry(taskName, action, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable =
        /Frame has been detached|Execution context was destroyed|Target closed|Navigation failed/i.test(
          message
        );
      if (!retryable || attempt >= maxAttempts) {
        break;
      }
      console.warn(`[WARN] ${taskName} 第 ${attempt} 次失败，准备重试: ${message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function generateOneVideo(browser, description, index, outputDir) {
  const outputName = sanitizeFileName(description, index);
  const outputPath = path.join(outputDir, outputName);
  console.log(`[${index + 1}] 开始生成: ${description}`);

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("未检测到可用浏览器上下文，请先打开一个 Chrome 标签页并登录");
  }
  const page = await context.newPage();
  try {
    await runWithRetry(`任务${index + 1}页面导航`, async () => {
      await page.goto(CONFIG.aiStudioUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    }, CONFIG.maxNavigateRetry);

    await runWithRetry(`任务${index + 1}生成流程`, async () => {
      await fillPromptAndGenerate(page, description);
    }, CONFIG.maxNavigateRetry);

    console.log(
      `[${index + 1}] 已提交生成，固定等待 ${Math.round(CONFIG.waitAfterGenerateMs / 1000)} 秒`
    );
    await sleep(CONFIG.waitAfterGenerateMs);
    await runWithRetry(`任务${index + 1}等待与下载`, async () => {
      await waitForVideoReady(page, {
        intervalMs: CONFIG.pollIntervalMs,
        maxWaitMs: CONFIG.maxWaitMs,
      });
      await triggerDownload(page, outputPath);
    }, CONFIG.maxNavigateRetry);

    console.log(`[${index + 1}] 已保存: ${outputPath}`);
    return outputPath;
  } catch (error) {
    const shotPath = path.join(outputDir, `${path.parse(outputName).name}.png`);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    throw new Error(`${error.message}；已保存诊断截图: ${shotPath}`);
  }
  finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const descriptionsPath = path.resolve(process.cwd(), CONFIG.descriptionsFile);
  const outputDir = path.resolve(process.cwd(), CONFIG.outputDir);
  await fs.mkdir(outputDir, { recursive: true });

  const descriptions = await readDescriptions(descriptionsPath);
  console.log(`读取到 ${descriptions.length} 条描述，并发=${CONFIG.concurrent}`);
  console.log(`页面模式（非 API 调用），期望模型: ${CONFIG.expectedModelName}`);
  console.log(`目标页面: ${CONFIG.aiStudioUrl}`);

  const browser = await connectChrome(CONFIG.cdpUrl);
  const limit = pLimit(CONFIG.concurrent);

  try {
    const tasks = descriptions.map((desc, index) =>
      limit(async () => {
        try {
          return await generateOneVideo(browser, desc, index, outputDir);
        } catch (error) {
          console.error(`[${index + 1}] 失败: ${error.message}`);
          return null;
        }
      })
    );
    const results = await Promise.all(tasks);
    const success = results.filter(Boolean).length;
    const failed = results.length - success;
    console.log(`任务完成: 成功 ${success}, 失败 ${failed}`);
  } finally {
    // 只断开连接，不关闭用户自己的 Chrome。
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("脚本执行失败:", error.message);
  process.exitCode = 1;
});
