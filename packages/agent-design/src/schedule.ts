// When a scheduled agent runs. The dashboard offers a few shapes (every hour,
// every day, weekdays, one day a week) and this turns the choice into the cron
// expression the agent runtime takes. Cron is never accepted as free text.

export const SCHEDULE_FREQUENCIES = ["hourly", "daily", "weekdays", "weekly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export interface ScheduleInput {
  frequency: ScheduleFrequency;
  /** "HH:MM", 24-hour, in `timezone`. For hourly, only the minutes are used. */
  time: string;
  /** For weekly: 0 (Sunday) to 6 (Saturday). */
  weekday?: number;
  /** IANA timezone, e.g. "Europe/London". */
  timezone: string;
}

export interface BuiltSchedule {
  /** 5-field POSIX cron, matched against the wall clock in `timezone`. */
  cron: string;
  timezone: string;
  /** How it reads to a person, e.g. "Weekdays at 08:00". */
  label: string;
}

export class ScheduleError extends Error {}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isTimezone(value: string): boolean {
  if (value === "UTC") return true;
  try {
    // Throws a RangeError for anything that isn't an IANA zone.
    new Intl.DateTimeFormat("en", { timeZone: value });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(value);
  } catch {
    return false;
  }
}

export function buildSchedule(input: ScheduleInput): BuiltSchedule {
  if (!SCHEDULE_FREQUENCIES.includes(input.frequency)) throw new ScheduleError("Choose how often it should run.");
  const match = typeof input.time === "string" ? input.time.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
  if (!match) throw new ScheduleError("Give the time as HH:MM, like 08:00.");
  if (typeof input.timezone !== "string" || !isTimezone(input.timezone)) throw new ScheduleError("That timezone isn't one we recognise.");

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const at = `${match[1]}:${match[2]}`;
  const timezone = input.timezone;

  switch (input.frequency) {
    case "hourly":
      return { cron: `${minute} * * * *`, timezone, label: minute === 0 ? "Every hour, on the hour" : `Every hour, at ${minute} past` };
    case "daily":
      return { cron: `${minute} ${hour} * * *`, timezone, label: `Every day at ${at}` };
    case "weekdays":
      return { cron: `${minute} ${hour} * * 1-5`, timezone, label: `Weekdays at ${at}` };
    case "weekly": {
      const day = input.weekday;
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) throw new ScheduleError("Choose which day of the week.");
      return { cron: `${minute} ${hour} * * ${day}`, timezone, label: `Every ${WEEKDAYS[day]} at ${at}` };
    }
  }
}
