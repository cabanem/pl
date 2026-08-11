# PMLE Chapter 2 — Practice Questions (Fresh Set)

Twelve scenario questions in the exam's style. Answer key with explanations is at the bottom — don't scroll past the divider until you've committed to answers. Target: 10/12 or better before moving on.

---

## Questions

**1.** You are analyzing a new tabular dataset before training. You want to quickly identify, for a single numeric feature, whether outliers exist and how the middle 50% of values is distributed. Which visualization should you use?

- A. Scatterplot
- B. Line plot
- C. Box plot
- D. Bar plot

**2.** A dataset of household incomes has mean $84,000, median $61,000, and mode $52,000. What does this tell you about the distribution?

- A. It is left-skewed with outliers on the low end
- B. It is right-skewed, likely with high-value outliers
- C. It is symmetric and approximately normal
- D. The data contains too many missing values to characterize

**3.** You are preparing features for a deep neural network. One feature, "session duration," is uniformly distributed between 0 and 3,600 seconds with no outliers. Another feature, "page views per user," follows a power-law distribution where most users have under 20 views but some have over 500,000. Which preprocessing combination is most appropriate?

- A. Z-score both features
- B. Linearly scale session duration; log-scale page views
- C. Clip both features at the 95th percentile
- D. Log-scale session duration; linearly scale page views

**4.** A feature is roughly normally distributed but contains a handful of moderate outliers you want to detect systematically rather than visually. After transforming the feature, which values should be flagged as outliers?

- A. Any value more than 1 standard deviation from the mean
- B. Any transformed value outside the range −3 to +3
- C. Any value below the median
- D. Any value outside the interquartile range

**5.** Your team wants training pipelines to automatically reject incoming data that violates expected types, ranges, or distributions — both during training and in production serving. According to Google's recommended approach, what artifact should the exploratory data analysis phase produce to enable this?

- A. A correlation matrix
- B. A data schema
- C. A holdout test set
- D. A feature importance report

**6.** You need to run TensorFlow Data Validation over a multi-terabyte dataset stored in BigQuery. Which GCP service should execute the TFDV pipeline at scale?

- A. Cloud Functions
- B. Vertex AI Workbench
- C. Dataflow
- D. Cloud Run

**7.** A sensor-failure dataset has 99,000 negative examples and 1,000 positive examples. Following Google's recommended practice for imbalanced data, you downsample the negative class by a factor of 20. What else must you do?

- A. Assign the downsampled negative examples a weight of 20 during training
- B. Assign the positive examples a weight of 20 during training
- C. Duplicate the positive examples 20 times
- D. Nothing further; downsampling alone restores balance

**8.** You are building a model to classify support tickets by topic. Tickets about the same product incident cluster tightly in time and share near-identical wording. You randomly split the data and achieve 98% test accuracy, but production accuracy is far lower. What is the most likely cause and fix?

- A. Class imbalance; oversample the minority topics
- B. Near-duplicate tickets landed in both train and test sets; split by time instead
- C. Missing values in the ticket text; impute with the most frequent category
- D. Features were not normalized; apply z-score scaling

**9.** An online prediction system retrains weekly on the trailing 30 days of data. Which validation strategy best mirrors production conditions?

- A. Randomly hold out 10% of the 30-day window
- B. Train on days 1–29 and validate on day 30
- C. Train on all 30 days and validate on a random sample of the same window
- D. Use k-fold cross-validation with shuffled folds

**10.** A numeric feature "account age" is missing in 4% of rows in a small dataset. You choose to impute missing values with the column median rather than dropping the rows. Which limitation of this approach should you keep in mind?

- A. It always increases the number of one-hot encoded columns
- B. It ignores covariance with other features and can introduce leakage
- C. It only works for categorical features
- D. It requires a time-series index

**11.** You normalize your entire dataset (computing the mean and standard deviation over all rows), then split it into training and test sets. The model's test accuracy is excellent but production performance is poor. Why?

- A. The test set was too small
- B. Normalization statistics computed over the full dataset leaked test-set information into training
- C. Z-score normalization is inappropriate for neural networks
- D. The split ratio should have been 80/20 instead of 70/30

**12. (Choose two.)** During EDA on a loan-default model, you find that (1) the feature "collections_agency_assigned" is almost perfectly correlated with the default label, and (2) preprocessing was applied to the full dataset before splitting. Which two statements are correct?

- A. "collections_agency_assigned" is label leakage: it records an event that happens *after* default, so it won't be available at prediction time
- B. High correlation with the target always means the feature is valuable and should be kept
- C. Preprocessing before splitting causes the model to indirectly learn from the test set
- D. Preprocessing before splitting is safe as long as the split is time-based

---
---

## Answer Key

**1. C** — Box plot. Quartiles show the middle 50% (the interquartile body) and points beyond the whiskers are outliers, in a single univariate view. A scatterplot needs two variables; line plots show trends over time; bar plots compare categories.

**2. B** — Right-skewed. When mean > median > mode, a long right tail (high outliers) is pulling the mean upward — the income pattern from the chapter. The mean–median gap is itself a skew diagnostic.

**3. B** — Match technique to distribution: uniform with no outliers → linear scaling; power-law spanning orders of magnitude → log scaling. Z-scoring the power-law feature (A) leaves it badly skewed; clipping (C) throws away legitimate signal on a feature that isn't the problem.

**4. B** — Z-score, flagging outside ±3. Note the chapter's "one standard deviation is unusual" line is an error — ~32% of normal data falls outside ±1σ. The chapter's own z-score section gives ±3, which is the exam convention.

**5. B** — The schema is the output of EDA and becomes the contract: types, ranges, formats, distributions. It powers metadata-driven preprocessing and anomaly detection at both training and serving time.

**6. C** — TFDV's APIs are built on Apache Beam, and Dataflow is GCP's managed Beam runner, integrating natively with BigQuery and GCS. This TFDV → Beam → Dataflow chain is a near-guaranteed exam fact.

**7. A** — Downsample and **upweight the downsampled (majority) class** by the same factor. Weight 20 makes each retained negative example count 20× in the loss, preserving the true base rate while giving the minority class proportionally more training exposure. Upweighting the *minority* class (B) is the trap answer.

**8. B** — Naturally clustered data + random split = near-duplicates straddling the train/test boundary, inflating test accuracy. This is the book-topics example wearing a support-ticket costume. Time-based split is the fix.

**9. B** — Split by time so the validation set mirrors the training-to-serving lag. Any random strategy (A, C, D) lets the model validate on data contemporaneous with — or older than — its training data, which production never allows.

**10. B** — Median imputation is fine for small datasets but ignores relationships between features and can contribute to leakage (the imputation statistic itself encodes dataset-wide information). A describes categorical imputation's cost; D describes interpolation.

**11. B** — Classic preprocess-before-split leakage. The mean/stddev "know about" test rows, so the training data was transformed using test-set information. Correct procedure: fit normalization on the training split only, then apply those parameters to test.

**12. A and C** — Collections agencies are assigned *because* a default occurred; the feature is a post-outcome artifact that won't exist at prediction time (label leakage, detectable via the suspicious correlation). And whole-dataset preprocessing leaks test information regardless of how the split is later performed, so D is false. B is the leakage trap inverted — suspiciously high correlation is a warning sign, not a gift.

---

**Scoring guide:** 10+ correct → move to Chapter 3. 8–9 → reread the scaling table and leakage sections. Below 8 → redo the chapter's own review questions first, then retake this set.