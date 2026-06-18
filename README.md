# Poda Closet Google Sheets Site

This is a static HTML/CSS/JS closet tracker connected to your published Google Sheets CSV.

## Files

- `index.html`
- `style.css`
- `script.js`

## Current CSV URL

https://docs.google.com/spreadsheets/d/e/2PACX-1vSEYtCDQrbxiln-82ECtRwK_8hq6_3bo0uVGu1IRKtKEuVqsk8xWQ2x_sL7CatdyQ/pub?gid=2076140585&single=true&output=csv

## Expected Google Sheet columns

Your `Inventory` tab should have these exact headers:

```text
id
brand
name
category
status
value
price
liquidity
thesis
listingUrl
imageUrl
```

## Status values

Use these exact status values:

```text
Closet
Listed
Sold
```

## Important notes

- Do not put words like `Sold for $145` in `price` if you want clean math.
- Use `$145` or `145`.
- For `value`, ranges like `$120-$160` are okay. The site uses the midpoint for metrics.
- For `imageUrl`, use a direct image URL when possible.
- There are no fallback/sample items. If the sheet does not load, the site shows an empty error state.
