function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export const MONGODB_URI = need("MONGODB_URI");
export const PORT = Number(need("PORT"));
export const MEDIA_DIR = need("MEDIA_DIR");
// optional: turns the cleanup rules off and locks them on the Settings page
export const NO_AUTO_DELETE = /^(1|true|yes)$/i.test(process.env.HOMETUBE_NO_AUTO_DELETE || "");
