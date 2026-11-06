package main

import (
	"math"
	"time"
)

// Fee rules, mirrored in public/fees.js for the page (fees_test.go fails if the two drift apart).
// Free for anything requested before Feb 1, 2027 00:00 Pacific (PST = UTC-8); after that feePct of the final amount.
var promoEnd = time.Date(2027, time.February, 1, 8, 0, 0, 0, time.UTC)

const feePct = 10

func pctAt(t time.Time) int {
	if t.Before(promoEnd) {
		return 0
	}
	return feePct
}

// feeFor returns the fee and the engineer's payout, rounded to cents.
func feeFor(amount, pct int) (fee, payout float64) {
	fee = math.Round(float64(amount*pct)) / 100
	return fee, math.Round((float64(amount)-fee)*100) / 100
}
