import os
import pandas as pd
import json
import xgboost as xgb
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance
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
    y_train = train_df[target]
    
    X_test = test_df[features]
    y_test = test_df[target]

    print("Training XGBoost Regressor...")
    # Use poisson objective as we are predicting counts
    model = xgb.XGBRegressor(objective='count:poisson', n_estimators=100, learning_rate=0.1, max_depth=5, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_pred = [max(0, p) for p in y_pred]

    mae = mean_absolute_error(y_test, y_pred)
    
    # Poisson deviance requires strictly positive predictions
    y_pred_pd = [max(1e-6, p) for p in y_pred]
    poisson_dev = mean_poisson_deviance(y_test, y_pred_pd)
    
    print(f"XGBoost MAE: {mae:.4f}, Poisson Deviance: {poisson_dev:.4f}")

    # Feature Importance
    importance = model.feature_importances_
    fi_df = pd.DataFrame({'feature': features, 'importance': importance})
    fi_df.to_csv(os.path.join(OUTPUT_DIR, "model08_xgb_feature_importance.csv"), index=False)

    # Save results
    results = {
        "model": "XGBoost",
        "MAE": float(mae),
        "Poisson_Deviance": float(poisson_dev),
        "predictions": [float(p) for p in y_pred]
    }
    with open(os.path.join(OUTPUT_DIR, "model08_xgb_results.json"), "w") as f:
        json.dump(results, f, indent=4)

    joblib.dump(model, os.path.join(OUTPUT_DIR, "model08_xgb.pkl"))
    print("XGBoost training complete.")

if __name__ == "__main__":
    main()
