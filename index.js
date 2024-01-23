const config = require("./config");
const path = require("path");
const http = require("http");
const https = require("https");
const { promises: fs } = require("fs");
const fsExtra = require("fs-extra");
const puppeteer = require("puppeteer");
const { CronJob } = require("cron");
const gm = require("gm");

// keep state of current battery level and whether the device is charging
const batteryStore = {};

(async () => {
  if (config.pages.length === 0) {
    return console.error("Please check your configuration");
  }
  for (const i in config.pages) {
    const pageConfig = config.pages[i];
    if (pageConfig.rotation % 90 > 0) {
      return console.error(
        `Invalid rotation value for entry ${i + 1}: ${pageConfig.rotation}`
      );
    }
  }

  console.log("Starting browser...");
  let browser = await puppeteer.launch({
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      `--lang=${config.language}`,
      config.ignoreCertificateErrors && "--ignore-certificate-errors"
    ].filter((x) => x),
    timeout: config.browserLaunchTimeout,
    headless: config.debug !== true
  });

  console.log(`Visiting '${config.baseUrl}' to login...`);
  let page = await browser.newPage();
  await page.goto(config.baseUrl, {
    timeout: config.renderingTimeout
  });

  const hassTokens = {
    hassUrl: config.baseUrl,
    access_token: config.accessToken,
    token_type: "Bearer"
  };

  console.log("Adding authentication entry to browser's local storage...");
  await page.evaluate(
    (hassTokens, selectedLanguage) => {
      localStorage.setItem("hassTokens", hassTokens);
      localStorage.setItem("selectedLanguage", selectedLanguage);
    },
    JSON.stringify(hassTokens),
    JSON.stringify(config.language)
  );

  page.close();

  if (config.debug) {
    console.log(
      "Debug mode active, will only render once in non-headless model and keep page open"
    );
    renderAndConvertAsync(browser);
  } else {
    console.log("Starting first render...");
    await renderAndConvertAsync(browser);
    console.log("Starting rendering cronjob...");
    new CronJob({
      cronTime: config.cronJob,
      onTick: () => renderAndConvertAsync(browser),
      start: true
    });
  }

async function renderAndConvertAsync(browser) {
  for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
    const pageConfig = config.pages[pageIndex];
    const pageBatteryStore = batteryStore[pageIndex];

    const url = `${config.baseUrl}${pageConfig.screenShotUrl}`;

    const outputPath = pageConfig.outputPath;
    await fsExtra.ensureDir(path.dirname(outputPath));

    const tempPath = outputPath + ".temp";

    console.log(`Rendering ${url} to image...`);
    await renderUrlToImageAsync(browser, pageConfig, url, tempPath);

    console.log(`Converting rendered screenshot of ${url} to grayscale png...`);
    await convertImageToKindleCompatiblePngAsync(
      pageConfig,
      tempPath,
      outputPath
    );

    fs.unlink(tempPath);
    console.log(`Finished ${url}`);

    if (
      pageBatteryStore &&
      pageBatteryStore.batteryLevel !== null &&
      pageConfig.batteryWebHook
    ) {
      sendBatteryLevelToHomeAssistant(
        pageIndex,
        pageBatteryStore,
        pageConfig.batteryWebHook
      );
    }
  }
}

function sendBatteryLevelToHomeAssistant(
  pageIndex,
  batteryStore,
  batteryWebHook
) {
  const batteryStatus = JSON.stringify(batteryStore);
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(batteryStatus)
    },
    rejectUnauthorized: !config.ignoreCertificateErrors
  };
  const url = `${config.baseUrl}/api/webhook/${batteryWebHook}`;
  const httpLib = url.toLowerCase().startsWith("https") ? https : http;
  const req = httpLib.request(url, options, (res) => {
    if (res.statusCode !== 200) {
      console.error(
        `Update device ${pageIndex} at ${url} status ${res.statusCode}: ${res.statusMessage}`
      );
    }
  });
  req.on("error", (e) => {
    console.error(`Update ${pageIndex} at ${url} error: ${e.message}`);
  });
  req.write(batteryStatus);
  req.end();
}

async function renderUrlToImageAsync(browser, pageConfig, url, path) {
  let page;
  try {
    page = await browser.newPage();
    await page.emulateMediaFeatures([
      {
        name: "prefers-color-scheme",
        value: `${pageConfig.prefersColorScheme}`
      }
    ]);

    let size = {
      width: Number(pageConfig.renderingScreenSize.width),
      height: Number(pageConfig.renderingScreenSize.height)
    };

    if (pageConfig.rotation % 180 > 0) {
      size = {
        width: size.height,
        height: size.width
      };
    }

    await page.setViewport(size);
    const startTime = new Date().valueOf();
    await page.goto(url, {
      waitUntil: ["domcontentloaded", "load", "networkidle0"],
      timeout: config.renderingTimeout
    });

    const navigateTimespan = new Date().valueOf() - startTime;
    await page.waitForSelector("home-assistant", {
      timeout: Math.max(config.renderingTimeout - navigateTimespan, 1000)
    });

    await page.addStyleTag({
      content: `
        body {
          width: calc(${size.width}px / ${pageConfig.scaling});
          height: calc(${size.height}px / ${pageConfig.scaling});
          transform-origin: 0 0;
          transform: scale(${pageConfig.scaling});
          overflow: hidden;
        }`
    });

    if (pageConfig.renderingDelay > 0) {
      await page.waitForTimeout(pageConfig.renderingDelay);
    }
    await page.screenshot({
      path,
      type: "bmp",
      clip: {
        x: 0,
        y: 0,
        ...size
      }
    });
  } catch (e) {
    console.error("Failed to render", e);
  } finally {
    if (config.debug === false) {
      await page.close();
    }
  }
}

function convertImageToKindleCompatiblePngAsync(
  pageConfig,
  inputPath,
  outputPath
) {
  return new Promise((resolve, reject) => {
    gm(inputPath)
      .options({
        imageMagick: config.useImageMagick === true
      })
      .gamma(pageConfig.removeGamma ? 1.0/2.2 : 1.0)
      .dither(pageConfig.dither)
      .rotate("white", pageConfig.rotation)
      .type(pageConfig.colorMode)
      .level(pageConfig.blackLevel, pageConfig.whiteLevel)
      .bitdepth(pageConfig.grayscaleDepth)
      .quality(100)
      .write(outputPath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
  });
}
