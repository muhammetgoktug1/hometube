// Paging (HOMETUBE_PAGING=1): the home page shows only the videos not watched yet, a few of each channel, and the
// channel page a page at a time, each with a "Show more" button (src/utils/homeFeed.js). It all happens in the browser:
// the library is sent as before. This only tells every new connection that it's on; off, nothing here runs.

// Clients page their grids only after hearing this, so with the flag off they draw everything, as before.
export const NOTICE = "paging:on";

const ON = process.env.HOMETUBE_PAGING === "1";

export function startPaging(io) {
  if (!ON) return;
  io.on("connection", (socket) => socket.emit(NOTICE));
}
