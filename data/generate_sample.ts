/** Generate deterministic personal-finance sample CSVs into data/sample/. */
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PythonFloat = Readonly<{ kind: "python-float"; value: number }>;
type CsvValue = string | number | PythonFloat;
type CsvRow = readonly CsvValue[];

const OUTPUT_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "sample",
);
const DAY_IN_MILLISECONDS = 86_400_000;
const MONTHLY_SALARY = 6_200;

const CATEGORIES = [
  ["Groceries", 620],
  ["Dining out", 240],
  ["Rent", 1_900],
  ["Transport", 210],
  ["Utilities", 185],
  ["Entertainment", 140],
  ["Health", 120],
  ["Shopping", 260],
  ["Travel", 0],
  ["Subscriptions", 55],
  ["Insurance", 130],
  ["Gym", 45],
] as const;

const PAYEES: Readonly<Record<string, readonly string[]>> = {
  Groceries: ["Whole Foods", "Costco", "Trader Joe's", "Safeway", "Lidl"],
  "Dining out": [
    "Chipotle",
    "Local Bistro",
    "Pizza Place",
    "Sushi Bar",
    "Coffee Shop",
  ],
  Rent: ["Riverside Properties"],
  Transport: ["Shell", "Uber", "City Transit", "EV Charging"],
  Utilities: ["Hydro Co", "Gas Co", "Internet Co", "Mobile Carrier"],
  Entertainment: ["Cinema", "Steam", "Spotify", "Concert Hall"],
  Health: ["Pharmacy", "Dental Clinic", "Walk-in Clinic"],
  Shopping: ["Amazon", "Nike", "Uniqlo", "Best Buy", "IKEA"],
  Travel: ["Airline", "Airbnb", "Booking.com", "Railway"],
  Subscriptions: ["Spotify", "Netflix", "iCloud", "Notion"],
  Insurance: ["Auto Insurance", "Renters Insurance"],
  Gym: ["Fitness Planet"],
};

/**
 * CPython-compatible Mersenne Twister for the subset used by random.Random.
 * Keeping its seeding, random(), and getrandbits() behavior makes this port
 * regenerate the historical seed-42 fixtures byte for byte.
 */
class PythonRandom {
  static readonly STATE_SIZE = 624;
  static readonly PERIOD = 397;
  static readonly MATRIX_A = 0x9908_b0df;
  static readonly UPPER_MASK = 0x8000_0000;
  static readonly LOWER_MASK = 0x7fff_ffff;

  readonly state = new Uint32Array(PythonRandom.STATE_SIZE);
  index = PythonRandom.STATE_SIZE;

  constructor(seed: number) {
    this.seed(seed);
  }

  seed(seed: number): void {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError("seed must be an unsigned 32-bit integer");
    }

    this.initializeByArray([seed]);
  }

  random(): number {
    const high = this.nextUint32() >>> 5;
    const low = this.nextUint32() >>> 6;
    return (high * 67_108_864 + low) / 9_007_199_254_740_992;
  }

  integer(minimum: number, maximum: number): number {
    return minimum + this.below(maximum - minimum + 1);
  }

  choice<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("cannot choose from an empty array");
    }

    return values[this.below(values.length)]!;
  }

  weightedChoice<T>(values: readonly T[], weights: readonly number[]): T {
    if (values.length === 0 || values.length !== weights.length) {
      throw new RangeError(
        "values and weights must have the same non-zero length",
      );
    }

    const cumulativeWeights: number[] = [];
    let total = 0;
    for (const weight of weights) {
      total += weight;
      cumulativeWeights.push(total);
    }

    const target = this.random() * total;
    let low = 0;
    let high = values.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (target < cumulativeWeights[middle]!) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    return values[low]!;
  }

  uniform(minimum: number, maximum: number): number {
    return minimum + (maximum - minimum) * this.random();
  }

  private initialize(seed: number): void {
    this.state[0] = seed >>> 0;
    for (let index = 1; index < PythonRandom.STATE_SIZE; index += 1) {
      const previous = this.state[index - 1]!;
      this.state[index] =
        (Math.imul(previous ^ (previous >>> 30), 1_812_433_253) + index) >>> 0;
    }
    this.index = PythonRandom.STATE_SIZE;
  }

  private initializeByArray(seed: readonly number[]): void {
    this.initialize(19_650_218);
    let stateIndex = 1;
    let seedIndex = 0;

    for (
      let remaining = Math.max(PythonRandom.STATE_SIZE, seed.length);
      remaining > 0;
      remaining -= 1
    ) {
      const previous = this.state[stateIndex - 1]!;
      this.state[stateIndex] =
        ((this.state[stateIndex]! ^
          Math.imul(previous ^ (previous >>> 30), 1_664_525)) +
          seed[seedIndex]! +
          seedIndex) >>>
        0;
      stateIndex += 1;
      seedIndex += 1;
      if (stateIndex >= PythonRandom.STATE_SIZE) {
        this.state[0] = this.state[PythonRandom.STATE_SIZE - 1]!;
        stateIndex = 1;
      }
      if (seedIndex >= seed.length) {
        seedIndex = 0;
      }
    }

    for (
      let remaining = PythonRandom.STATE_SIZE - 1;
      remaining > 0;
      remaining -= 1
    ) {
      const previous = this.state[stateIndex - 1]!;
      this.state[stateIndex] =
        ((this.state[stateIndex]! ^
          Math.imul(previous ^ (previous >>> 30), 1_566_083_941)) -
          stateIndex) >>>
        0;
      stateIndex += 1;
      if (stateIndex >= PythonRandom.STATE_SIZE) {
        this.state[0] = this.state[PythonRandom.STATE_SIZE - 1]!;
        stateIndex = 1;
      }
    }

    this.state[0] = 0x8000_0000;
  }

  private below(limit: number): number {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("limit must be a positive safe integer");
    }

    const bitCount = Math.floor(Math.log2(limit)) + 1;
    let value = this.getRandBits(bitCount);
    while (value >= limit) {
      value = this.getRandBits(bitCount);
    }
    return value;
  }

  private getRandBits(bitCount: number): number {
    return this.nextUint32() >>> (32 - bitCount);
  }

  private nextUint32(): number {
    if (this.index >= PythonRandom.STATE_SIZE) {
      let cursor = 0;
      for (
        ;
        cursor < PythonRandom.STATE_SIZE - PythonRandom.PERIOD;
        cursor += 1
      ) {
        const combined =
          (this.state[cursor]! & PythonRandom.UPPER_MASK) |
          (this.state[cursor + 1]! & PythonRandom.LOWER_MASK);
        this.state[cursor] =
          (this.state[cursor + PythonRandom.PERIOD]! ^
            (combined >>> 1) ^
            (combined & 1 ? PythonRandom.MATRIX_A : 0)) >>>
          0;
      }
      for (; cursor < PythonRandom.STATE_SIZE - 1; cursor += 1) {
        const combined =
          (this.state[cursor]! & PythonRandom.UPPER_MASK) |
          (this.state[cursor + 1]! & PythonRandom.LOWER_MASK);
        this.state[cursor] =
          (this.state[
            cursor + (PythonRandom.PERIOD - PythonRandom.STATE_SIZE)
          ]! ^
            (combined >>> 1) ^
            (combined & 1 ? PythonRandom.MATRIX_A : 0)) >>>
          0;
      }

      const combined =
        (this.state[PythonRandom.STATE_SIZE - 1]! & PythonRandom.UPPER_MASK) |
        (this.state[0]! & PythonRandom.LOWER_MASK);
      this.state[PythonRandom.STATE_SIZE - 1] =
        (this.state[PythonRandom.PERIOD - 1]! ^
          (combined >>> 1) ^
          (combined & 1 ? PythonRandom.MATRIX_A : 0)) >>>
        0;
      this.index = 0;
    }

    let value = this.state[this.index]!;
    this.index += 1;
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c_5680;
    value ^= (value << 15) & 0xefc6_0000;
    value ^= value >>> 18;
    return value >>> 0;
  }
}

function roundToTwoDecimals(value: number): number {
  return Number(value.toFixed(2));
}

function pythonFloat(value: number): PythonFloat {
  return { kind: "python-float", value };
}

function comparableValue(value: CsvValue): string | number {
  return typeof value === "object" ? value.value : value;
}

function compareRows(left: CsvRow, right: CsvRow): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const leftValue = comparableValue(left[index]!);
    const rightValue = comparableValue(right[index]!);
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
    } else {
      const leftString = String(leftValue);
      const rightString = String(rightValue);
      if (leftString < rightString) return -1;
      if (leftString > rightString) return 1;
    }
  }
  return left.length - right.length;
}

function formatCsvValue(value: CsvValue): string {
  if (typeof value !== "object") return String(value);
  if (Number.isInteger(value.value)) {
    return `${Object.is(value.value, -0) ? "-0" : String(value.value)}.0`;
  }
  return String(value.value);
}

function formatCsv(rows: readonly CsvRow[]): string {
  return `${rows.map((row) => row.map(formatCsvValue).join(",")).join("\r\n")}\r\n`;
}

async function writeCsv(
  fileName: string,
  rows: readonly CsvRow[],
): Promise<void> {
  await writeFile(join(OUTPUT_DIRECTORY, fileName), formatCsv(rows), "utf8");
}

async function main(): Promise<void> {
  const random = new PythonRandom(42);
  const transactions: CsvRow[] = [];
  const categoryNames = CATEGORIES.map(([category]) => category);
  const categoryWeights = CATEGORIES.map(([, weight]) => weight);
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2025, 11, 31);

  for (
    let timestamp = start;
    timestamp <= end;
    timestamp += DAY_IN_MILLISECONDS
  ) {
    const day = new Date(timestamp);
    const dayOfMonth = day.getUTCDate();
    const month = day.getUTCMonth() + 1;
    const date = day.toISOString().slice(0, 10);

    if (dayOfMonth === 5 || dayOfMonth === 19) {
      transactions.push([
        date,
        "Payroll",
        "Salary",
        MONTHLY_SALARY,
        "Checking",
        "income",
      ]);
    }
    if (month === 3 && dayOfMonth === 15) {
      transactions.push([
        date,
        "IRS Refund",
        "Tax refund",
        pythonFloat(840.5),
        "Checking",
        "income",
      ]);
    }
    if (month === 6 && dayOfMonth === 15) {
      transactions.push([
        date,
        "Bank",
        "Interest",
        pythonFloat(random.uniform(15, 40)),
        "Savings",
        "income",
      ]);
    }
    if ((month === 6 || month === 12) && random.random() < 0.35) {
      const amount = random.uniform(420, 1_500);
      transactions.push([
        date,
        random.choice(PAYEES.Travel!),
        "Travel",
        pythonFloat(-roundToTwoDecimals(amount)),
        "Credit card",
        "expense",
      ]);
    }
    if (dayOfMonth === 3) {
      transactions.push([
        date,
        "Riverside Properties",
        "Rent",
        -1_900,
        "Checking",
        "expense",
      ]);
    }
    if (dayOfMonth === 4) {
      transactions.push([
        date,
        "Auto Insurance",
        "Insurance",
        -130,
        "Checking",
        "expense",
      ]);
      transactions.push([
        date,
        "Fitness Planet",
        "Gym",
        -45,
        "Checking",
        "expense",
      ]);
    }
    if (dayOfMonth === 6) {
      transactions.push([
        date,
        "Spotify",
        "Subscriptions",
        pythonFloat(-11.99),
        "Credit card",
        "expense",
      ]);
      transactions.push([
        date,
        "Netflix",
        "Subscriptions",
        pythonFloat(-15.49),
        "Credit card",
        "expense",
      ]);
    }

    const expenseCount = random.integer(0, 3);
    for (let expense = 0; expense < expenseCount; expense += 1) {
      const category = random.weightedChoice(categoryNames, categoryWeights);
      const payee = random.choice(PAYEES[category] ?? ["Unknown"]);
      const amount = random.uniform(8, category === "Rent" ? 0 : 160);
      transactions.push([
        date,
        payee,
        category,
        pythonFloat(-roundToTwoDecimals(amount)),
        random.choice(["Credit card", "Checking"]),
        "expense",
      ]);
    }
  }

  transactions.sort(compareRows);

  const budgetRows: CsvRow[] = [["month", "category", "amount", "type"]];
  for (let month = 1; month <= 12; month += 1) {
    const formattedMonth = `2025-${String(month).padStart(2, "0")}`;
    for (const [category, amount] of CATEGORIES) {
      budgetRows.push([formattedMonth, category, amount, "Budget"]);
    }
    budgetRows.push([
      formattedMonth,
      "Salary",
      pythonFloat(MONTHLY_SALARY * 2.15),
      "Income",
    ]);
  }

  const accountRows: CsvRow[] = [
    ["account", "institution", "type", "opened"],
    ["Checking", "First National", "Checking", "2021-03-14"],
    ["Savings", "First National", "Savings", "2021-03-14"],
    ["Credit card", "First National", "Credit card", "2022-01-09"],
    ["Brokerage", "Schwab", "Investment", "2023-08-30"],
  ];

  const netWorthRows: CsvRow[] = [
    ["quarter", "assets", "liabilities", "net_worth"],
  ];
  let netWorth = 42_000;
  for (let quarter = 1; quarter <= 4; quarter += 1) {
    const assets = netWorth + random.uniform(8_000, 14_000);
    const liabilities = random.uniform(6_500, 8_000);
    netWorthRows.push([
      `2025-Q${quarter}`,
      Math.round(assets),
      Math.round(liabilities),
      Math.round(assets - liabilities),
    ]);
    netWorth += 9_000;
  }

  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await writeCsv("transactions.csv", [
    ["date", "payee", "category", "amount", "account", "type"],
    ...transactions,
  ]);
  await writeCsv("budget.csv", budgetRows);
  await writeCsv("accounts.csv", accountRows);
  await writeCsv("networth.csv", netWorthRows);

  console.log("sample data written:");
  for (const fileName of (await readdir(OUTPUT_DIRECTORY)).sort()) {
    if (fileName.endsWith(".csv")) {
      const details = await stat(join(OUTPUT_DIRECTORY, fileName));
      console.log(" ", fileName, details.size, "bytes");
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
