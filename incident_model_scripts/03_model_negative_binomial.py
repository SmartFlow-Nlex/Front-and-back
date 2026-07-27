import os
import pandas as pd
import json
import statsmodels.api as sm
import statsmodels.formula.api as smf
from sklearn.metrics import mean_absolute_error
from sklearn.metrics import mean_poisson_deviance
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

    formula = "incident_count ~ hour_of_day + day_of_week + is_weekend + C(location_id) + is_rush_hour + is_holiday"
    features = ['hour_of_day', 'day_of_week', 'is_weekend', 'location_id', 'is_rush_hour', 'is_holiday']
    target = 'incident_count'
    
    # Formula for statsmodels
    formula = f"{target} ~ " + " + ".join(['hour_of_day', 'day_of_week', 'is_weekend', 'C(location_id)', 'is_rush_hour', 'is_holiday'])

    print("Training Negative Binomial Regression...")
    try:
        print("NaN counts in train_df:")
        print(train_df[features].isnull().sum())
        model = smf.glm(formula=formula, data=train_df, family=sm.families.NegativeBinomial()).fit()
        
        y_test = test_df[target]
        y_pred = model.predict(test_df)
        y_pred = [max(0, p) for p in y_pred]

        mae = mean_absolute_error(y_test, y_pred)
        y_pred_pd = [max(1e-6, p) for p in y_pred]
        poisson_dev = mean_poisson_deviance(y_test, y_pred_pd)
        
        print(f"Negative Binomial MAE: {mae:.4f}, Poisson Deviance: {poisson_dev:.4f}")

        # Feature Importance (use absolute t-values or p-values)
        importance = model.tvalues
        if 'Intercept' in importance.index:
            importance = importance.drop('Intercept')
        importance = importance.abs()
        fi_df = pd.DataFrame({'feature': importance.index, 'importance': importance.values})
        fi_df['importance'] = fi_df['importance'] / fi_df['importance'].sum() # Normalize
        fi_df.to_csv(os.path.join(OUTPUT_DIR, "model03_nb_feature_importance.csv"), index=False)

        # Save results
        results = {
            "model": "Negative Binomial Regression",
            "MAE": float(mae),
            "Poisson_Deviance": float(poisson_dev),
            "predictions": [float(p) for p in y_pred]
        }
        with open(os.path.join(OUTPUT_DIR, "model03_nb_results.json"), "w") as f:
            json.dump(results, f, indent=4)

        joblib.dump(model, os.path.join(OUTPUT_DIR, "model03_nb.pkl"))
        print("Negative Binomial training complete.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Negative Binomial Failed: {e}")

if __name__ == "__main__":
    main()
