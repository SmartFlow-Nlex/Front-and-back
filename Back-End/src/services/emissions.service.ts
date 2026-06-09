import { env } from "../config/env.js";

type CarbonEmissionInput = {
  time_reported: string;
  time_cleared: string;
  daily_volume: number;
};

type CarbonEmissionResult = {
  row_index: number;
  time_reported: string;
  time_cleared: string;
  daily_volume: number;
  delay_minutes: number;
  trapped_vehicles: number;
  idling_penalty_co2_kg: number;
};

type ClimatiqEstimateResponse = {
  co2e?: number;
};

function parseTimeToSeconds(value: string) {
  const [hours, minutes, seconds] = value.split(":").map(Number);

  if ([hours, minutes, seconds].some((part) => Number.isNaN(part))) {
    throw new Error("time_reported and time_cleared must use HH:MM:SS format");
  }

  return hours * 3600 + minutes * 60 + seconds;
}

async function getIdlingFactor() {
  if (!env.CLIMATIQ_API_KEY) {
    throw new Error("Missing CLIMATIQ_API_KEY");
  }

  const response = await fetch("https://beta4.api.climatiq.io/estimate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLIMATIQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      emission_factor: {
        activity_id: "passenger_vehicle-vehicle_type_car-fuel_source_petrol",
        region: "GLOBAL",
      },
      parameters: {
        distance: 1,
        distance_unit: "km",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Climatiq request failed with status ${response.status}`);
  }

  const data = (await response.json()) as ClimatiqEstimateResponse;
  return Number(data.co2e ?? 0) * 0.10;
}

function calculateRow(input: CarbonEmissionInput, rowIndex: number, idlingFactor: number): CarbonEmissionResult {
  const reportedSeconds = parseTimeToSeconds(input.time_reported);
  const clearedSeconds = parseTimeToSeconds(input.time_cleared);

  let delayMinutes = (clearedSeconds - reportedSeconds) / 60;
  if (delayMinutes < 0) {
    delayMinutes += 24 * 60;
  }

  const delayMinutesRounded = Number(delayMinutes.toFixed(2));
  const trappedVehicles = Math.round((input.daily_volume / 1440) * delayMinutesRounded);
  const idlingPenaltyCo2Kg = Number((trappedVehicles * delayMinutesRounded * idlingFactor).toFixed(2));

  return {
    row_index: rowIndex,
    time_reported: input.time_reported,
    time_cleared: input.time_cleared,
    daily_volume: input.daily_volume,
    delay_minutes: delayMinutesRounded,
    trapped_vehicles: trappedVehicles,
    idling_penalty_co2_kg: idlingPenaltyCo2Kg,
  };
}

export async function getEmissionsData() {
  return {
    module: "emissions",
    message: "emissions API ready",
    updatedAt: new Date().toISOString(),
  };
}

export async function calculateCarbonEmissionData(input: CarbonEmissionInput) {
  const idlingFactor = await getIdlingFactor();
  return calculateRow(input, 1, idlingFactor);
}

export async function calculateCarbonEmissionBatch(inputs: CarbonEmissionInput[]) {
  const idlingFactor = await getIdlingFactor();
  return inputs.map((input, index) => calculateRow(input, index + 1, idlingFactor));
}
