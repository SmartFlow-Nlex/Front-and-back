import os
import json
import pandas as pd

OUTPUT_DIR = "output"

def main():
    print("Comparing Incident Probability Models...")
    
    # Load model results
    results = []
    
    rf_file = os.path.join(OUTPUT_DIR, "model02_rf_results.json")
    if os.path.exists(rf_file):
        with open(rf_file, "r") as f:
            results.append(json.load(f))
            
    xgb_poisson_file = os.path.join(OUTPUT_DIR, "model03_xgb_poisson_results.json")
    if os.path.exists(xgb_poisson_file):
        with open(xgb_poisson_file, "r") as f:
            results.append(json.load(f))
            
    if not results:
        print("No model results found. Please run 02_model_random_forest.py and 03_model_negative_binomial.py first.")
        return

    # Create comparison DataFrame
    df = pd.DataFrame(results)
    
    # We want to minimize MAE and Poisson_Deviance
    # Sort primarily by Poisson Deviance, then MAE
    if "Poisson_Deviance" in df.columns:
        df = df.sort_values(by=["Poisson_Deviance", "MAE"], ascending=[True, True])
    else:
        df = df.sort_values(by=["MAE"], ascending=[True])
        
    print("\n=== Model Comparison ===")
    print(df.to_string(index=False))
    
    champion = df.iloc[0]["model"]
    print(f"\n🏆 CHAMPION MODEL: {champion}")
    
    # Save the evaluation report
    report = {
        "champion_model": champion,
        "metrics_ranking": df.to_dict(orient="records")
    }
    
    with open(os.path.join(OUTPUT_DIR, "eval01_model_comparison.json"), "w") as f:
        json.dump(report, f, indent=4)
        
    df.to_csv(os.path.join(OUTPUT_DIR, "eval01_model_ranking.csv"), index=False)
    print(f"\nSaved evaluation report to {OUTPUT_DIR}/eval01_model_comparison.json")

if __name__ == "__main__":
    main()
