import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reportable, throttle } from "./reportable";

const page = "http://localhost:5173";

describe("reportable", () => {
  it("counts an uncaught error from the page's own file and not one from a CDN", () => {
    expect(reportable("uncaught", { file: `${page}/src/App.tsx` }, page)).toBe(true);
    expect(reportable("uncaught", { file: "https://cdn.example.com/analytics.js" }, page)).toBe(false);
  });

  it("skips the opaque Script error a cross-origin script raises", () => {
    expect(reportable("uncaught", {}, page)).toBe(false);
  });

  it("reads a rejection's source from its top frame, and counts one with no source", () => {
    const ours = `TypeError: x\n    at load (${page}/src/api.ts:4:11)`;
    const theirs = "TypeError: x\n    at https://cdn.example.com/sdk.js:1:200";
    expect(reportable("rejection", { stack: ours }, page)).toBe(true);
    expect(reportable("rejection", { stack: theirs }, page)).toBe(false);
    expect(reportable("rejection", {}, page)).toBe(true);
  });

  it("treats a bundler's own scheme as the page's code", () => {
    const next = "Error: x\n    at Page (webpack-internal:///(app-pages-browser)/./app/page.js:9:11)";
    expect(reportable("rejection", { stack: next }, page)).toBe(true);
  });

  it("counts a same-origin 5xx or failure, never a 4xx or another origin", () => {
    expect(reportable("request", { file: "/api/me", status: 502 }, page)).toBe(true);
    expect(reportable("request", { file: `${page}/api/me`, status: "failed" }, page)).toBe(true);
    expect(reportable("request", { file: "/api/me", status: 404 }, page)).toBe(false);
    expect(reportable("request", { file: "https://api.example.com/x", status: 500 }, page)).toBe(false);
  });

  it("counts an overlay and never console output", () => {
    expect(reportable("overlay", {}, page)).toBe(true);
    expect(reportable("error", { file: `${page}/src/App.tsx` }, page)).toBe(false);
    expect(reportable("warn", {}, page)).toBe(false);
  });
});

describe("throttle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("posts a 60 Hz burst once a second, first at once and last at the end", () => {
    const post = vi.fn();
    const call = throttle(1000, post);
    for (let i = 0; i < 180; i++) {
      call();
      vi.advanceTimersByTime(1000 / 60);
    }
    expect(post).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(post).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(5000);
    expect(post).toHaveBeenCalledTimes(4);
  });
});
