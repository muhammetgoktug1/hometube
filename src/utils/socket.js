import { io } from "socket.io-client";
import { authFor } from "./profile";

let socket;

// one socket.io connection, opened on first use
export const getSocket = () => {
  socket ||= io({ auth: authFor() });
  return socket;
};
