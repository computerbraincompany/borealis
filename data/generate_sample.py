"""Generate realistic personal-finance sample CSVs into data/sample/."""
import csv
import random
from datetime import date, timedelta

from pathlib import Path

random.seed(42)

OUT = Path(__file__).resolve().parent / "sample"

CATEGORIES = {
    "Groceries": 620, "Dining out": 240, "Rent": 1900, "Transport": 210,
    "Utilities": 185, "Entertainment": 140, "Health": 120, "Shopping": 260,
    "Travel": 0, "Subscriptions": 55, "Insurance": 130, "Gym": 45,
}
PAYEES = {
    "Groceries": ["Whole Foods", "Costco", "Trader Joe's", "Safeway", "Lidl"],
    "Dining out": ["Chipotle", "Local Bistro", "Pizza Place", "Sushi Bar", "Coffee Shop"],
    "Rent": ["Riverside Properties"],
    "Transport": ["Shell", "Uber", "City Transit", "EV Charging"],
    "Utilities": ["Hydro Co", "Gas Co", "Internet Co", "Mobile Carrier"],
    "Entertainment": ["Cinema", "Steam", "Spotify", "Concert Hall"],
    "Health": ["Pharmacy", "Dental Clinic", "Walk-in Clinic"],
    "Shopping": ["Amazon", "Nike", "Uniqlo", "Best Buy", "IKEA"],
    "Travel": ["Airline", "Airbnb", "Booking.com", "Railway"],
    "Subscriptions": ["Spotify", "Netflix", "iCloud", "Notion"],
    "Insurance": ["Auto Insurance", "Renters Insurance"],
    "Gym": ["Fitness Planet"],
}
MONTHY_SALARY = 6200  # bi-weekly alternating
START = date(2025, 1, 1)
END = date(2025, 12, 31)

transactions = []
d = START
salary_paycheck = True
while d <= END:
    # salary every two weeks from the 5th
    if d.day in (5, 19):
        transactions.append([d.isoformat(), "Payroll", "Salary", MONTHY_SALARY, "Checking", "income"])
    if d == date(d.year, 3, 15):
        transactions.append([d.isoformat(), "IRS Refund", "Tax refund", 840.50, "Checking", "income"])
    if d == date(d.year, 6, 15):
        transactions.append([d.isoformat(), "Bank", "Interest", random.uniform(15, 40), "Savings", "income"])
    # a small chance of a travel purchase around summer and holidays
    for month in [6, 12]:
        if d.month == month and random.random() < 0.35:
            amt = random.uniform(420, 1500)
            transactions.append([d.isoformat(), random.choice(PAYEES["Travel"]), "Travel", -round(amt, 2), "Credit card", "expense"])
    # regular monthly categories
    if d.day == 3:
        transactions.append([d.isoformat(), "Riverside Properties", "Rent", -1900, "Checking", "expense"])
    if d.day == 4:
        transactions.append([d.isoformat(), "Auto Insurance", "Insurance", -130, "Checking", "expense"])
        transactions.append([d.isoformat(), "Fitness Planet", "Gym", -45, "Checking", "expense"])
    if d.day == 6:
        transactions.append([d.isoformat(), "Spotify", "Subscriptions", -11.99, "Credit card", "expense"])
        transactions.append([d.isoformat(), "Netflix", "Subscriptions", -15.49, "Credit card", "expense"])
    # random daily expenses
    n_exp = random.randint(0, 3)
    for _ in range(n_exp):
        cat = random.choices(list(CATEGORIES), weights=list(CATEGORIES.values()))[0]
        payee = random.choice(PAYEES.get(cat, ["Unknown"]))
        amt = random.uniform(8, 160 if cat != "Rent" else 0)
        transactions.append([d.isoformat(), payee, cat, -round(amt, 2), random.choice(["Credit card", "Checking"]), "expense"])
    d += timedelta(days=1)

transactions.sort()
with open(f"{OUT}/transactions.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["date", "payee", "category", "amount", "account", "type"])
    w.writerows(transactions)

# budget by month+category
budget_rows = []
for month in range(1, 13):
    for cat, val in CATEGORIES.items():
        budget_rows.append([f"2025-{month:02d}", cat, val, "Budget"])
    budget_rows.append([f"2025-{month:02d}", "Salary", MONTHY_SALARY * 2.15, "Income"])
with open(f"{OUT}/budget.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["month", "category", "amount", "type"])
    w.writerows(budget_rows)

# accounts
with open(f"{OUT}/accounts.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["account", "institution", "type", "opened"])
    w.writerows([
        ["Checking", "First National", "Checking", "2021-03-14"],
        ["Savings", "First National", "Savings", "2021-03-14"],
        ["Credit card", "First National", "Credit card", "2022-01-09"],
        ["Brokerage", "Schwab", "Investment", "2023-08-30"],
    ])

# net worth by quarter
with open(f"{OUT}/networth.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["quarter", "assets", "liabilities", "net_worth"])
    nw = 42000
    for q in [1, 2, 3, 4]:
        assets = nw + random.uniform(8000, 14000)
        liabilities = random.uniform(6500, 8000)
        w.writerow([f"2025-Q{q}", round(assets), round(liabilities), round(assets - liabilities)])
        nw += 9000

print("sample data written:")
import os
for fn in sorted(os.listdir(OUT)):
    if fn.endswith(".csv"):
        print(" ", fn, os.path.getsize(os.path.join(OUT, fn)), "bytes")
