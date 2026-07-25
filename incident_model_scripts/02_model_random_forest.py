import os
import pandas as pd
import json
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.metrics import mean_poisson_deviance
import joblib

OUTPUT_DIR = "output"

def main():
    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    if not os.path.exists(train_file) or not os.path.exists(test_file):
        print("Train/test datasets not found. Run dataset builder first.")
        return

    train_df = pd.read_csv(train_file)
    test_df = pd.read_csv(test_file)

    features = ['hour_of_day', 'day_of_week', 'is_weekend', 'location_id', 'is_rush_hour', 'is_holiday']
    target = 'incident_count'

    X_train = train_df[features]
    y_train = train_df[target]
    X_test = test_df[features]
    y_test = test_df[target]

    print("Training Random Forest...")
    model = RandomForestRegressor(n_estimators=100, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_pred = [max(0, p) for p in y_pred] # ensure non-negative for poisson deviance

    mae = mean_absolute_error(y_test, y_pred)
    # Adding small epsilon to avoid poisson deviance error if y_pred is 0
    y_pred_pd = [max(1e-6, p) for p in y_pred]
    try:
        poisson_dev = mean_poisson_deviance(y_test, y_pred_pd)
    except Exception:
        poisson_dev = 999.0

    print(f"Random Forest MAE: {mae:.4f}, Poisson Deviance: {poisson_dev:.4f}")

    # Feature Importance
    importance = model.feature_importances_
    fi_df = pd.DataFrame({'feature': features, 'importance': importance})
    fi_df.to_csv(os.path.join(OUTPUT_DIR, "model02_rf_feature_importance.csv"), index=False)

    # Save results
    results = {
        "model": "Random Forest",
        "MAE": float(mae),
        "Poisson_Deviance": float(poisson_dev),
        "predictions": [float(p) for p in y_pred]
    }
    with open(os.path.join(OUTPUT_DIR, "model02_rf_results.json"), "w") as f:
        json.dump(results, f, indent=4)
        
    joblib.dump(model, os.path.join(OUTPUT_DIR, "model02_rf.pkl"))
    print("Random Forest training complete.")

if __name__ == "__main__":
    main()
