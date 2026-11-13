import mongoose from "mongoose";
import { PROFILES } from "./config.js";
import { Category, Channel, Video } from "./models.js";
import { followChannel } from "./sync.js";
import { createGate } from "./profileGate.js";
import { profileWire as wire } from "./profileRules.js";

// Everyone at home gets their own library: their own videos, categories, follows and where they left
// off. Off unless HOMETUBE_PROFILES=1, and then nothing here runs: no collection, no event, no room.
// A video is still saved and downloaded once; profiles link to it from four collections of their own
// (profiles, profilevideos, profilecategories, profilefollows), the library's own are only read.
// With HOMETUBE_KIDS=1 too, a profile can be a kids profile (kid), which watches but can't add, remove
// or change anything (KIDS in lib/profileRules.js); without it kid is neither read nor written.
const KIDS_ON = PROFILES && /^(1|true|yes)$/i.test(process.env.HOMETUBE_KIDS || "");

const HOUR = 3_600_000;
const PENDING = ["queued", "waiting", "downloading"];

const str = (id) => String(id);
const ms = (date) => (date ? new Date(date).getTime() : 0);
const profileWire = (p) => wire(p, KIDS_ON);
const duplicate = (err) => err?.code === 11000 || err?.writeErrors?.every?.((e) => e.code === 11000);

// created only when profiles are on, so the collections don't exist otherwise
function compileModels() {
  const { ObjectId } = mongoose.Schema.Types;
  const profile = new mongoose.Schema(
    {
      name: { type: String, required: true },
      // the name in lower case: two profiles can't share a name
      nameKey: { type: String, required: true, unique: true },
      // avatar hue (COLORS in lib/profileRules.js)
      color: Number,
      // a kids profile (HOMETUBE_KIDS=1); not in the schema without it, so nothing can write it
      ...(KIDS_ON ? { kid: Boolean } : {}),
    },
    { timestamps: true },
  );
  // A video in a profile, with the profile's own category, watch time and position.
  const link = new mongoose.Schema({
    profile: { type: ObjectId, ref: "Profile", required: true },
    video: { type: ObjectId, ref: "Video", required: true, index: true },
    category: { type: ObjectId, ref: "ProfileCategory" },
    watchedAt: Date,
    position: { type: Number, default: 0 },
    // when the profile added it; moved videos keep the day they were saved
    addedAt: { type: Date, default: Date.now },
  });
  link.index({ profile: 1, video: 1 }, { unique: true });
  const category = new mongoose.Schema(
    {
      profile: { type: ObjectId, ref: "Profile", required: true },
      name: { type: String, required: true, trim: true, maxlength: 40 },
      order: { type: Number, default: 0 },
    },
    { timestamps: true },
  );
  category.index({ profile: 1, order: 1 });
  // the library follows a channel (channels.follow) while at least one profile does
  const follow = new mongoose.Schema(
    {
      profile: { type: ObjectId, ref: "Profile", required: true },
      channel: { type: ObjectId, ref: "Channel", required: true, index: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );
  follow.index({ profile: 1, channel: 1 }, { unique: true });
  return {
    Profile: mongoose.model("Profile", profile, "profiles"),
    Link: mongoose.model("ProfileVideo", link, "profilevideos"),
    ProfileCategory: mongoose.model("ProfileCategory", category, "profilecategories"),
    Follow: mongoose.model("ProfileFollow", follow, "profilefollows"),
  };
}

// What lib/profileGate.js reads and writes; ids go in and out as strings, dates as milliseconds.
function mongoStore({ Profile, Link, ProfileCategory, Follow }) {
  const members = async (profile) => (await Link.find({ profile }, { video: 1 }).lean()).map((l) => l.video);
  const unassigned = async () => ({ _id: { $nin: await Link.distinct("video") } });
  const insert = async (Model, docs) => {
    if (!docs.length) return [];
    try {
      return await Model.insertMany(docs, { ordered: false });
    } catch (err) {
      // linked meanwhile by another request: the rest went in
      if (!duplicate(err)) throw err;
      return err.insertedDocs || [];
    }
  };
  return {
    async profiles() {
      return (await Profile.find().sort({ createdAt: 1 }).lean()).map(profileWire);
    },
    async profileById(id) {
      const p = await Profile.findById(id).lean();
      return p ? profileWire(p) : null;
    },
    async profileByKey(key) {
      const p = key ? await Profile.findOne({ nameKey: key }).lean() : null;
      return p ? profileWire(p) : null;
    },
    async createProfile(fields) {
      try {
        return profileWire(await Profile.create(fields));
      } catch (err) {
        if (duplicate(err)) return null;
        throw err;
      }
    },
    async updateProfile(id, fields) {
      try {
        const p = await Profile.findByIdAndUpdate(id, fields, { returnDocument: "after" }).lean();
        return p ? profileWire(p) : null;
      } catch (err) {
        if (duplicate(err)) return null;
        throw err;
      }
    },
    async deleteProfile(id) {
      await Promise.all([Link.deleteMany({ profile: id }), ProfileCategory.deleteMany({ profile: id }), Follow.deleteMany({ profile: id })]);
      await Profile.deleteOne({ _id: id });
    },
    async videoCounts() {
      const rows = await Link.aggregate([{ $group: { _id: "$profile", n: { $sum: 1 } } }]);
      return new Map(rows.map((r) => [str(r._id), r.n]));
    },
    async orphanCount() {
      return Video.countDocuments(await unassigned());
    },
    async orphans() {
      const videos = await Video.find(await unassigned(), { category: 1, watchedAt: 1, position: 1, createdAt: 1 }).sort({ createdAt: 1 }).lean();
      return videos.map((v) => ({ id: str(v._id), category: v.category ? str(v.category) : "", watchedAt: ms(v.watchedAt), position: v.position || 0, addedAt: ms(v.createdAt) }));
    },
    async oldCategories() {
      return (await Category.find().sort({ order: 1, createdAt: 1 }).lean()).map((c) => ({ id: str(c._id), name: c.name }));
    },
    async unfollowedChannels() {
      const [followed, taken] = await Promise.all([Channel.find({ follow: true }, { _id: 1 }).lean(), Follow.distinct("channel")]);
      const has = new Set(taken.map(str));
      return followed.map((c) => str(c._id)).filter((id) => !has.has(id));
    },
    async links(profile) {
      const links = await Link.find({ profile }).lean();
      return links.map((l) => ({ video: str(l.video), category: l.category ? str(l.category) : "", watchedAt: ms(l.watchedAt), position: l.position || 0, addedAt: ms(l.addedAt) }));
    },
    async isMember(profile, video) {
      return !!(await Link.exists({ profile, video }));
    },
    // links the videos the profile doesn't have yet: the ids it got
    async link(profile, videos, { category } = {}) {
      const ids = [...new Set(videos.map(str))];
      if (!ids.length) return [];
      const have = new Set((await Link.find({ profile, video: { $in: ids } }, { video: 1 }).lean()).map((l) => str(l.video)));
      const addedAt = new Date();
      const docs = await insert(Link, ids.filter((video) => !have.has(video)).map((video) => ({ profile, video, category, addedAt })));
      return docs.map((d) => str(d.video));
    },
    async claimLinks(profile, links) {
      const docs = await insert(
        Link,
        links.map((l) => ({ profile, video: l.video, category: l.category, watchedAt: l.watchedAt ? new Date(l.watchedAt) : undefined, position: l.position, addedAt: new Date(l.addedAt) })),
      );
      return docs.map((d) => str(d.video));
    },
    async unlink(profile, video) {
      return (await Link.deleteOne({ profile, video })).deletedCount > 0;
    },
    async linkCount(video) {
      return Link.countDocuments({ video });
    },
    // fields: category (null takes it away), watchedAt (ms), position
    async setLink(profile, video, fields) {
      const update = {};
      if ("category" in fields) fields.category ? (update.category = fields.category) : (update.$unset = { category: 1 });
      if (fields.watchedAt) update.watchedAt = new Date(fields.watchedAt);
      if (fields.position !== undefined) update.position = fields.position;
      return (await Link.updateOne({ profile, video }, update)).matchedCount > 0;
    },
    async pendingOf(profile, channel) {
      const videos = await Video.find({ _id: { $in: await members(profile) }, channel, status: { $in: PENDING } }, { _id: 1 }).lean();
      return videos.map((v) => str(v._id));
    },
    async memberVideos(profile) {
      const videos = await Video.find({ _id: { $in: await members(profile) } }, { ytId: 1, channel: 1, size: 1 }).lean();
      return videos.map((v) => ({ id: str(v._id), ytId: v.ytId, channel: str(v.channel), size: v.size || 0 }));
    },
    async videoByYtId(ytId) {
      const v = await Video.findOne({ ytId }, { _id: 1 }).lean();
      return v ? { id: str(v._id) } : null;
    },
    async videosByYtIds(ytIds) {
      if (!ytIds.length) return [];
      return (await Video.find({ ytId: { $in: ytIds } }, { ytId: 1 }).lean()).map((v) => ({ id: str(v._id), ytId: v.ytId }));
    },
    async isReady(video) {
      return !!(await Video.exists({ _id: video, status: "ready" }));
    },
    async channel(id) {
      const c = await Channel.findById(id, { follow: 1 }).lean();
      return c ? { id: str(c._id), follow: !!c.follow } : null;
    },
    async channelsSince(date) {
      return (await Channel.find({ updatedAt: { $gte: date } }, { _id: 1 }).lean()).map((c) => str(c._id));
    },
    async shortsOf(channels) {
      return (await Video.find({ channel: { $in: channels }, short: true }, { _id: 1 }).lean()).map((v) => str(v._id));
    },
    async categories(profile) {
      return (await ProfileCategory.find({ profile }).sort({ order: 1, createdAt: 1 }).lean()).map((c) => ({ id: str(c._id), name: c.name }));
    },
    async hasCategory(profile, id) {
      return !!(await ProfileCategory.exists({ _id: id, profile }));
    },
    async addCategory(profile, name) {
      const c = await ProfileCategory.create({ profile, name, order: await ProfileCategory.countDocuments({ profile }) });
      return str(c._id);
    },
    async addCategories(profile, list) {
      const docs = list.length ? await ProfileCategory.insertMany(list.map((c) => ({ profile, ...c }))) : [];
      return docs.map((c) => ({ id: str(c._id), name: c.name }));
    },
    async removeCategory(profile, id) {
      const { deletedCount } = await ProfileCategory.deleteOne({ _id: id, profile });
      if (deletedCount) await Link.updateMany({ profile, category: id }, { $unset: { category: 1 } });
    },
    async follows(profile) {
      return (await Follow.find({ profile }, { channel: 1 }).lean()).map((f) => str(f.channel));
    },
    async followers(channel) {
      return (await Follow.find({ channel }, { profile: 1 }).lean()).map((f) => str(f.profile));
    },
    async follow(profile, channel) {
      await Follow.updateOne({ profile, channel }, { $setOnInsert: { profile, channel } }, { upsert: true });
    },
    async unfollow(profile, channel) {
      await Follow.deleteOne({ profile, channel });
    },
  };
}

// Links left behind by videos, channels or profiles that are gone (removed while profiles were off,
// say) are dropped; never a video. Only links older than the look, so one made meanwhile stays.
async function forgetRemoved({ Profile, Link, ProfileCategory, Follow }) {
  const before = new Date();
  const [videos, followed, profiles] = await Promise.all([Video.distinct("_id"), Channel.distinct("_id", { follow: true }), Profile.distinct("_id")]);
  const links = await Link.deleteMany({ addedAt: { $lt: before }, video: { $nin: videos } });
  const follows = await Follow.deleteMany({ createdAt: { $lt: before }, channel: { $nin: followed } });
  // a profile whose deletion was cut short; looked up again in case it was created after the look
  const known = new Set(profiles.map(str));
  const ghosts = [...new Set([...(await Link.distinct("profile")), ...(await Follow.distinct("profile")), ...(await ProfileCategory.distinct("profile"))].map(str))];
  for (const ghost of ghosts.filter((id) => !known.has(id))) {
    if (await Profile.exists({ _id: ghost })) continue;
    await Promise.all([Link.deleteMany({ profile: ghost }), ProfileCategory.deleteMany({ profile: ghost }), Follow.deleteMany({ profile: ghost })]);
  }
  if (links.deletedCount || follows.deletedCount) console.log(`profiles: dropped ${links.deletedCount} links to removed videos and ${follows.deletedCount} follows`);
  return { profiles: profiles.length };
}

// io: the socket.io server; deps: { library, queueUploads, removeVideo } from server.js. Returns what
// server.js uses instead of its own while profiles are on ({ broadcast, queueUploads }), else {}.
export function startProfiles(io, deps) {
  if (!PROFILES) return {};
  const models = compileModels();
  const store = mongoStore(models);
  const gate = createGate({ store, io, upstream: { ...deps, followChannel }, kids: KIDS_ON });
  io.use((socket, next) => gate.handshake(socket).then(() => next()));
  io.on("connection", (socket) => gate.connect(socket));
  const tidy = () => forgetRemoved(models).catch((err) => console.error("profile cleanup failed", err.message));
  tidy()
    .then(async (res) => res && console.log(`profiles on: ${res.profiles} profiles, ${await store.orphanCount()} unassigned videos`))
    .catch((err) => console.error("profile count failed", err.message));
  if (KIDS_ON) store.profiles().then((list) => console.log(`kids profiles on: ${list.filter((p) => p.kid).length} of ${list.length} profiles`), (err) => console.error("profile count failed", err.message));
  setInterval(tidy, HOUR);
  return { broadcast: gate.broadcast, queueUploads: gate.forFollowers(deps.queueUploads) };
}
