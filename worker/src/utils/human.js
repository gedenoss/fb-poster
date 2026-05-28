'use strict';
const config = require('../config');

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  const lo = minMs ?? config.human.actionDelayMinMs;
  const hi = maxMs ?? config.human.actionDelayMaxMs;
  return sleep(randInt(lo, hi));
}

async function humanType(locator, text) {
  await locator.focus();
  for (const ch of text) {
    await locator.page().keyboard.type(ch, {
      delay: randInt(config.human.typingMinMs, config.human.typingMaxMs),
    });
    if (Math.random() < 0.04) await sleep(randInt(120, 450));
  }
}

async function microScroll(page) {
  const delta = randInt(-200, 400);
  await page.mouse.wheel(0, delta);
  await sleep(randInt(300, 900));
}

async function idleMouseMove(page) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.move(randInt(50, vp.width - 50), randInt(50, vp.height - 50), {
    steps: randInt(8, 20),
  });
}

module.exports = { randInt, sleep, randomDelay, humanType, microScroll, idleMouseMove };
