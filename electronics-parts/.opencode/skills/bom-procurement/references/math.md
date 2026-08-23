# Procurement math

required_qty = qty_per_unit * production_quantity
order_qty = max(required_qty, MOQ)
if order_multiple known: order_qty = ceil(order_qty / order_multiple) * order_multiple
unit_price = valid price tier for order_qty
line_total = order_qty * unit_price

Never use a price tier for a quantity threshold that order_qty does not reach.

Only sum `line_total` values in the same currency. Do not invent an exchange rate.
