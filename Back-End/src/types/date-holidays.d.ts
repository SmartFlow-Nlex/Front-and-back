declare module "date-holidays" {
  export interface HolidayItem {
    date: string;
    start: Date;
    end: Date;
    name: string;
    type: "public" | "bank" | "optional" | "observance";
    rule: string;
  }

  export default class Holidays {
    constructor(country?: string, state?: string, region?: string, opts?: Record<string, unknown>);
    getHolidays(year?: number | string): HolidayItem[];
  }
}
