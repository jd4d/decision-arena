// All gameplay constants. Changing any value changes results: bump SIM_VERSION.
export const SIM_VERSION = "sim-2";

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const ROUND_SECONDS = 60;
export const ROUND_TICKS = ROUND_SECONDS * TICK_HZ;

export const ARENA_W = 32; // meters
export const ARENA_H = 20;

export const TANK_RADIUS = 0.8;
export const TANK_HP = 3;
export const TANK_SPEED = 3.0; // m/s forward
export const TANK_REVERSE_SPEED = 2.0;
export const TANK_ARC_SPEED = 2.6; // forward while arcing
export const HULL_TURN_RATE = (150 * Math.PI) / 180; // rad/s when turning in place
export const HULL_ARC_TURN_RATE = (90 * Math.PI) / 180; // rad/s while arcing
export const TURRET_TURN_RATE = (120 * Math.PI) / 180; // rad/s at full command, relative to hull

export const SHELL_SPEED = 10; // m/s
export const SHELL_RADIUS = 0.15;
export const SHELL_MAX_BOUNCES = 1;
export const SHELL_LIFETIME_TICKS = 4 * TICK_HZ;
export const SHELL_SUBSTEPS = 4;
export const MUZZLE_OFFSET = TANK_RADIUS + 0.35;
export const RELOAD_TICKS = Math.round(1.0 * TICK_HZ);
export const MAX_SHELLS_PER_TANK = 2;
