'use strict';

const ANDROID_RE = /^(\d\d-\d\d)\s+(\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s?(.*)$/;
const IOS_RE = /^(\d{4}-\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+[^ ]*)\s+(\S+)\s+\[(\d+):(\d+)\]\s+\(([^)]+)\)\s+([^:]+):\s?(.*)$/;

const levels = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };

function parseAndroidLine(line) {
  const match = String(line).match(ANDROID_RE);
  if (!match) return { platform: 'android', level: 'unknown', tag: '', message: String(line), raw: String(line) };
  return {
    platform: 'android',
    timestamp: `${match[1]} ${match[2]}`,
    pid: Number(match[3]),
    tid: Number(match[4]),
    level: levels[match[5]] || 'unknown',
    tag: match[6].trim(),
    message: match[7],
    raw: String(line)
  };
}

function parseIosLine(line) {
  const text = String(line);
  const match = text.match(IOS_RE);
  if (!match) return { platform: 'ios', level: inferIosLevel(text), tag: '', message: text, raw: text };
  return {
    platform: 'ios',
    timestamp: match[1],
    process: match[2],
    pid: Number(match[3]),
    tid: Number(match[4]),
    subsystem: match[5],
    tag: match[6].trim(),
    level: inferIosLevel(text),
    message: match[7],
    raw: text
  };
}

function inferIosLevel(line) {
  const value = String(line).toLowerCase();
  if (/\bfault\b/.test(value)) return 'fatal';
  if (/\berror\b/.test(value)) return 'error';
  if (/\bwarn(?:ing)?\b/.test(value)) return 'warn';
  if (/\bdebug\b/.test(value)) return 'debug';
  if (/\binfo\b/.test(value)) return 'info';
  return 'default';
}

module.exports = { parseAndroidLine, parseIosLine, inferIosLevel };
