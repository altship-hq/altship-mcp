import { describe, expect, it } from "vitest";
import { ScheduleError, buildSchedule } from "./schedule.js";

describe("buildSchedule", () => {
  it("builds each shape", () => {
    expect(buildSchedule({ frequency: "hourly", time: "00:00", timezone: "UTC" })).toEqual({ cron: "0 * * * *", timezone: "UTC", label: "Every hour, on the hour" });
    expect(buildSchedule({ frequency: "hourly", time: "09:15", timezone: "UTC" })).toMatchObject({ cron: "15 * * * *", label: "Every hour, at 15 past" });
    expect(buildSchedule({ frequency: "daily", time: "08:05", timezone: "Europe/London" })).toEqual({ cron: "5 8 * * *", timezone: "Europe/London", label: "Every day at 08:05" });
    expect(buildSchedule({ frequency: "weekdays", time: "17:30", timezone: "America/New_York" })).toMatchObject({ cron: "30 17 * * 1-5", label: "Weekdays at 17:30" });
    expect(buildSchedule({ frequency: "weekly", time: "23:59", weekday: 0, timezone: "Africa/Lagos" })).toMatchObject({ cron: "59 23 * * 0", label: "Every Sunday at 23:59" });
  });

  it("rejects a time that isn't HH:MM", () => {
    for (const time of ["8:00", "24:00", "08:60", "0 * * * *", "", "08:00 * *"]) {
      expect(() => buildSchedule({ frequency: "daily", time, timezone: "UTC" })).toThrow(ScheduleError);
    }
  });

  it("rejects an unknown timezone, frequency or weekday", () => {
    expect(() => buildSchedule({ frequency: "daily", time: "08:00", timezone: "Mars/Olympus" })).toThrow(ScheduleError);
    expect(() => buildSchedule({ frequency: "daily", time: "08:00", timezone: "UTC\n* * * * *" })).toThrow(ScheduleError);
    expect(() => buildSchedule({ frequency: "minutely" as never, time: "08:00", timezone: "UTC" })).toThrow(ScheduleError);
    expect(() => buildSchedule({ frequency: "weekly", time: "08:00", timezone: "UTC" })).toThrow(ScheduleError);
    expect(() => buildSchedule({ frequency: "weekly", time: "08:00", weekday: 7, timezone: "UTC" })).toThrow(ScheduleError);
  });
});
