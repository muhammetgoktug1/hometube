import { execFile } from "node:child_process";

// fpcalc's default algorithm; kept with each fingerprint, so a later change can tell old ones apart
export const ALGORITHM = "chromaprint-1.6/2";

// The audio fingerprint of a whole file with fpcalc (Chromaprint): { fp, duration }, where fp is a
// Uint32Array of about 8 values a second. Runs at the lowest priority, so playback and downloads come first.
export function fingerprint(file) {
  const args = ["-n", "19", "fpcalc", "-json", "-raw", "-length", "0", file];
  return new Promise((resolve, reject) => {
    execFile("nice", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split("\n").pop()));
      try {
        const { fingerprint = [], duration = 0 } = JSON.parse(stdout);
        resolve({ fp: Uint32Array.from(fingerprint, (x) => x >>> 0), duration });
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}
