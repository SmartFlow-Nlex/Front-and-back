import os
import pandas as pd
import json
import numpy as np
import mord
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
from sklearn.preprocessing import StandardScaler
import joblib

OUTPUT_DIR = "output"

def main():
    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    if not os.path.exists(train_file) or not os.path.exists(test_file):
        print("Train/test datasets not found.")
        return

    train_df = pd.read_csv(train_file)
    test_df = pd.read_csv(test_file)

    features = ['hour_of_day', 'day_of_week', 'is_weekend', 'location_id', 'is_rush_hour', 'is_holiday']
    target = 'incident_count'

    X_train = train_df[features]
    # Mord requires classes to be integers starting from 0 (which incident counts naturally are!)
    y_train = train_df[target].astype(int)
    
    X_test = test_df[features]
    y_test = test_df[target]
    
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    print("Training Ordinal Logistic Regression...")
    model = mord.LogisticAT(alpha=1.0)
    model.fit(X_train_scaled, y_train)

    # To get continuous metrics, we can't just take the class prediction (0, 1, 2).
    # We must calculate the expected value: Sum(Class * Probability of Class)
    # model.predict_proba() returns probabilities for each class
    probas = model.predict_proba(X_test_scaled)
    classes = model.classes_
    
    # Calculate Expected Value
    y_pred = np.sum(probas * classes, axis=1)
    y_pred = [max(0, p) for p in y_pred]

    mae = mean_absolute_error(y_test, y_pred)
    
    # Poisson deviance requires strictly positive predictions
    y_pred_pd = [max(1e-6, p) for p in y_pred]
    poisson_dev = mean_poisson_deviance(y_test, y_pred_pd)
    
    print(f"Ordinal Logistic Regression MAE: {mae:.4f}, Poisson Deviance: {poisson_dev:.4f}")

    # Feature Importance (coefficients)
    importance = np.abs(model.coef_)
    fi_df = pd.DataFrame({'feature': features, 'importance': importance})
    fi_df['importance'] = fi_df['importance'] / fi_df['importance'].sum()
    fi_df.to_csv(os.path.join(OUTPUT_DIR, "model09_olr_feature_importance.csv"), index=False)

    # Save results
    results = {
        "model": "Ordinal Logistic Regression",
        "MAE": float(mae),
        "Poisson_Deviance": float(poisson_dev),
        "predictions": [float(p) for p in y_pred]
    }
    with open(os.path.join(OUTPUT_DIR, "model09_olr_results.json"), "w") as f:
        json.dump(results, f, indent=4)

    joblib.dump(model, os.path.join(OUTPUT_DIR, "model09_olr.pkl"))
    print("Ordinal Logistic Regression training complete.")

if __name__ == "__main__":
    main()
