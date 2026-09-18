/**
 * The request lifecycle — shared by the Worker (emails, validation), the
 * tracking page (timeline), and the admin console (board columns).
 *
 * `order` is the position on the "shipping" timeline. Statuses with
 * `terminal: true` end the timeline; `aside: true` are off-track states that
 * render as a notice rather than a step.
 */
export const STATUSES = {
  received: {
    order: 0,
    label: 'Request received',
    short: 'Received',
    blurb: "Your request landed in the queue. I'll look it over soon.",
    tone: 'neutral',
  },
  reviewing: {
    order: 1,
    label: 'Looking it over',
    short: 'Reviewing',
    blurb: 'Checking the file, size, and material to make sure it will print well.',
    tone: 'neutral',
  },
  queued: {
    order: 2,
    label: 'In the queue',
    short: 'Queued',
    blurb: "Approved and waiting for printer time. I'll let you know when it starts.",
    tone: 'neutral',
  },
  printing: {
    order: 3,
    label: 'On the printer',
    short: 'Printing',
    blurb: 'Layers are going down. Check back for live progress.',
    tone: 'active',
  },
  finishing: {
    order: 4,
    label: 'Post-processing',
    short: 'Finishing',
    blurb: 'Off the bed. Removing supports, cleaning up, and checking the fit.',
    tone: 'active',
  },
  ready: {
    order: 5,
    label: 'Ready for pickup',
    short: 'Ready',
    blurb: "It's done and waiting for you. I'll sort out the hand-off.",
    tone: 'good',
  },
  delivered: {
    order: 6,
    label: 'Delivered',
    short: 'Delivered',
    blurb: 'Handed over. Enjoy — send me a photo of it in the wild.',
    tone: 'good',
    terminal: true,
  },
  on_hold: {
    order: 99,
    label: 'On hold',
    short: 'On hold',
    blurb: 'Paused for now — usually waiting on a file fix or a material.',
    tone: 'warn',
    aside: true,
  },
  declined: {
    order: 99,
    label: "Can't print this one",
    short: 'Declined',
    blurb: 'This one is not a fit for my setup. See the note for why and what might work instead.',
    tone: 'bad',
    aside: true,
    terminal: true,
  },
};

export const STATUS_KEYS = Object.keys(STATUSES);

/** Steps shown on the tracking timeline, in order (excludes aside states). */
export const TRACK_STEPS = STATUS_KEYS.filter((k) => !STATUSES[k].aside).sort(
  (a, b) => STATUSES[a].order - STATUSES[b].order,
);

/** Admin board columns: active work left-to-right, then parked, then done. */
export const BOARD_COLUMNS = [
  'received',
  'reviewing',
  'queued',
  'printing',
  'finishing',
  'ready',
  'on_hold',
  'delivered',
  'declined',
];

export const MATERIALS = ['Any', 'PLA', 'PETG', 'TPU', 'ABS/ASA', 'Resin'];

export const isStatus = (s) => Object.prototype.hasOwnProperty.call(STATUSES, s);
