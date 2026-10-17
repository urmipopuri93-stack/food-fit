# Food inventory dataset

Source: https://www.kaggle.com/datasets/vinay24baghira/ai-powered-food-waste-management-dataset-v1
Publisher: Vinay Rai
License: CC BY 4.0
Data type: Synthetic business inventory records, not actual pantry operations.
Coverage: January–December 2025.
Records: 8,000.

Checks:
- No duplicate Inventory_ID values.
- Inventory calculations: 0 errors.
- Waste quantity checks: 0 errors.

Missing values:
- Shelf_Life_Days: 235
- Storage_Temperature: 186
- Daily_Demand: 210
- Weather: 203
- Donation_Made: 233

Limitations:
- Quantities are source units, not verified kilograms or meals.
- Customer demand is not pantry demand.
- Remaining stock is not automatically available for donation.
- No Dallas locations, coordinates, pantry demand, or storage capacities.
- Original files and missing values remain unchanged.
