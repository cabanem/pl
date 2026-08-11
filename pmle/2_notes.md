# PMLE Study Guide — Chapter 2: Exploring Data and Building Data Pipelines

**Exam objective covered:** 5.1 — Developing end-to-end ML pipelines (data and model validation)

**Chapter thesis:** Your model is only as good as your data. Most ML time is spent on cleaning and feature work, so this chapter is EDA → cleaning → validation-at-scale → dataset organization → leakage prevention.

---

## 1. Visualization

Two modes of analysis:

- **Univariate** — one feature at a time; range, distribution shape, outlier presence. Tools: box plots, distribution plots.
- **Bivariate** — two features together; surfaces correlation. Tools: line plots, bar plots, scatterplots.

Plot-to-purpose mapping (memorize this):

| Plot | Answers |
|---|---|
| Box plot | Distribution by quartiles (25/50/75), whiskers = min/max, points beyond whiskers = outliers |
| Line plot | Trend of a relationship over time |
| Bar plot | Comparison across categories (weekly sales, monthly revenue) |
| Scatterplot | Relationship between two variables; cluster visualization |

## 2. Statistics Fundamentals

Three measures of central tendency, chosen by data condition:

- **Mean** — use when there are *no* outliers (it's the outlier-sensitive one).
- **Median** — use when outliers exist. Odd n → middle value; even n → average of the two middle values.
- **Mode** — use when outliers exist AND most values repeat; the most frequent value(s).

**Outlier detection via central tendency:** adding one extreme value moves the mean dramatically while median and mode barely shift. The gap between mean and median is itself an outlier/skew signal.

- **Variance** — average of squared differences from the mean.
- **Standard deviation** — square root of variance; the workhorse for outlier detection.
- **Covariance** — how much two variables vary together (unnormalized).
- **Correlation** — normalized covariance; Pearson coefficient, range −1 to +1.
  - Positive: both move together. Negative: inverse. Zero: no substantial relationship.
  - **Exam hook:** a feature *too* correlated with the target is a label-leakage signal (canonical example: hospital name predicting cancer diagnosis — the model learns which hospitals treat cancer, not medicine).

## 3. Data Quality and Reliability

Reliability = degree you can trust the data. Unreliable data has missing values, duplicates, bad features. Checks: label errors (humans mislabel), feature noise (e.g., GPS jitter), outliers and skew.

### Data skew
- Non-symmetric distribution; skewness of a normal distribution = 0.
- Right-skewed real-world example: income (long tail of billionaires).
- Fix for skewed **features**: log transform / normalization.
- Fix for skew in the **target variable**: SMOTE, oversampling, or undersampling.

### Scaling decision table (highest-yield section of the chapter)

| Technique | When | Mechanism |
|---|---|---|
| **Linear scaling** | Uniform-ish distribution, few/no outliers (e.g., age) | Map natural range → [0,1] or [−1,+1] |
| **Log scaling** | Power-law / values spanning orders of magnitude | Compress large values into a common range |
| **Z-score** | A few outliers present | (value − mean) / stddev; ±3 is the normal band, outside = outlier |
| **Clipping** | *Extreme* outliers | Cap values above/below a fixed threshold; can apply before or after other normalization |

Why scale at all: gradient descent converges better on scaled features; avoids NaN traps; prevents wide-range features from dominating.

### Handling outliers
Detect with: box plots, z-score, clipping thresholds, IQR.
Then either **remove**, or **impute** to mean/median/mode/boundary values.

### Establishing data constraints — the schema
A schema (data type, allowed range, format, distribution) is the *output* of EDA and becomes a contract for the pipeline:
1. Enables metadata-driven preprocessing.
2. Validates new data — catches skew/outlier anomalies at both training and prediction time.

## 4. Validation at Big-Data Scale — TFDV

- Large datasets can't be validated in single-machine memory → need distributed validation.
- **TFDV** = TensorFlow Data Validation, part of **TFX**. Detects data anomalies and schema anomalies at scale.
- TFX library map (know all four): **TFDV** (validation) · **TF Transform** (preprocessing/feature engineering) · **TF Model Analysis** (evaluation) · **TF Serving** (serving).
- Two usage phases:
  1. **EDA phase** — generate the schema (the contract).
  2. **Production phase** — schema becomes the baseline for detecting skew/drift between training and serving.
- **On GCP:** TFDV APIs are built on **Apache Beam**; **Dataflow** is the managed Beam runner and integrates natively with BigQuery, GCS, and Vertex AI Pipelines. (Exam loves this chain: TFDV → Beam → Dataflow.)

## 5. Organizing and Optimizing Training Datasets

### The three splits
- **Training** — model learns from it.
- **Validation** — hyperparameter tuning / model improvement; model does not learn from it.
- **Test** — final evaluation only, after training AND validation; must share no samples with the other sets; never train on it.

### Imbalanced data
- Random over/undersampling both introduce bias.
- **Preferred technique: downsample the majority class + upweight it.** Downsample by factor N → assign example weight N (loss counts each retained example N times).
- Benefit: faster model convergence (minority class is proportionally better represented).
- Worked example: 1,000 no-fraud / 5 fraud → downsample majority by 10 → 100 no-fraud at weight 10 vs. 5 fraud.

### Data splitting
- Random split fails on **naturally clustered data** (e.g., book topics written in the same era) — near-duplicates land in both train and test.
- Fix: **time-based split** (train on earlier period, test on later).
- **Online systems:** always split by time, because training data is inherently older than serving data — the validation set should mirror that lag. Pattern: collect 30 days → train on days 1–29 → validate on day 30.
- Time-based splits work best on very large datasets. Use domain knowledge to choose random vs. time-based.

## 6. Handling Missing Data

Causes: recording failure, corruption. Manifests as NaN/null.

Strategy menu (know the trade-off attached to each):
1. **Drop** rows/columns (column if >half null). Cost: information loss.
2. **Impute numeric** with mean/median/mode. Works for small datasets; ignores covariance between features; can itself cause leakage.
3. **Impute categorical** with most-frequent category; or introduce a new "missing" category if nulls are numerous. Cost: extra one-hot dimension.
4. **LOCF** — last observation carried forward. Can reduce bias.
5. **Interpolation** — time-series only; interpolate between surrounding timestamps.
6. **Missing-tolerant algorithms** — k-NN (drops the column from distance), Naive Bayes; Random Forest adapts well to nonlinear/categorical data.
7. **Predict the missing values** with a regression/classification model using correlated non-missing features.

## 7. Data Leakage

Definition: test-time information reaches the model during training → great train/test metrics, poor real-world performance → **overfitting**.

Causes (all four are exam-question fodder):
1. Target variable accidentally included as a feature.
2. Test data mixed into training data at split time.
3. **Label leakage** — a feature that encodes the target and won't exist at serving time (detect via target-feature correlation).
4. **Preprocessing the whole dataset before splitting** — normalization statistics computed over train+test leak test information into training.

Time-series special case: using future data to compute current features. Usually caused by random splitting.

Warning signs: predictions suspiciously close to actuals; features with very high target correlation in EDA.

Prevention:
- Exclude target-correlated features.
- Maintain train/validation/test discipline; validation mimics real life.
- **Preprocess train and test separately** (fit normalization on train only).
- Time-series: enforce a time cutoff.
- Cross-validation for limited data — compute scaling parameters *per fold*.
- Match production lag: predicting 30-day LTV → validation split is 30 days after training split, test 30 days after validation.

---

## Exam Essentials (chapter's own checklist, condensed)

- Match plot type to question (box/line/bar/scatter).
- Mean vs. median vs. mode selection under outliers; stddev for outlier detection; correlation reading.
- Skew + the four scaling techniques and when each applies.
- Schema as pipeline contract; TFDV for validation at scale (and the Beam/Dataflow story).
- Train/validation/test roles; time-based splits for clustered and online data; downsample-and-upweight for imbalance.
- Missing-data strategy menu with trade-offs.
- Leakage causes and prevention — especially preprocess-after-split and time cutoffs.

## Review Question Answer Keys (my answers — verify against the appendix)

1. **D** — oversample the fraudulent (minority) transactions.
2. **A** — hospital name is label leakage via correlation with the target.
3. **A** — monitor for skew/drift with alerts, retrain on trigger (not blind monthly retraining).
4. **B** — market changed, model didn't: lack of retraining (data/concept drift).
5. **B** — downsample majority + upweight.
6. **A** — time-based split for hourly-uploaded temperature data.
7. **B** — normalize so gradient descent can converge across different feature ranges.
8. **A, B, D** — whole-dataset preprocessing, label leakage via high correlation, target-as-feature. (C, removing missing-value features, doesn't cause overfitting.)

## ⚠️ Errata / read-carefully flags in this chapter

1. **Table 2.1 columns are swapped.** Compute it yourself: without the 210 outlier, mean = 140/11 ≈ **12.7**; with it, mean = 350/12 ≈ **29.2**. The book prints these under the opposite headers (and the medians — 13 without, 14 with — are swapped too). The *lesson* (outliers move the mean, barely touch median/mode) is correct; the printed table contradicts it.
2. **Log scaling arithmetic is wrong.** "log(100,000) = 100 and log(100) = 10" — actually log₁₀(100,000) = 5 and log₁₀(100) = 2. The *concept* (log compresses orders of magnitude into a shared range) is what matters.
3. **"More than one standard deviation = unusual"** is much too aggressive (~32% of normal data lies outside ±1σ). The chapter's own z-score section gives the right convention: outside **±3** is the outlier threshold. Use ±3 (or ±2 for "unusual") on the exam.