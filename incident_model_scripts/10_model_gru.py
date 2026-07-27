import os
import pandas as pd
import json
import numpy as np
import tensorflow as tf
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance

OUTPUT_DIR = "output"

def create_sequences(X, y, time_steps):
    Xs, ys = [], []
    for i in range(len(X) - time_steps):
        Xs.append(X.iloc[i:(i + time_steps)].values)
        ys.append(y.iloc[i + time_steps])
    return np.array(Xs), np.array(ys)

def main():
    train_file = os.path.join(OUTPUT_DIR, "train_incident.csv")
    test_file = os.path.join(OUTPUT_DIR, "test_incident.csv")
    
    if not os.path.exists(train_file) or not os.path.exists(test_file):
        print("Train/test datasets not found.")
        return

    train_df = pd.read_csv(train_file)
    test_df = pd.read_csv(test_file)

    num_exits = len(train_df['location_id'].unique())

    features = ['hour_of_day', 'day_of_week', 'is_weekend', 'is_rush_hour', 'is_holiday']
    target = 'incident_count'

    scaler = StandardScaler()
    X_train_scaled = pd.DataFrame(scaler.fit_transform(train_df[features]), columns=features)
    X_test_scaled = pd.DataFrame(scaler.transform(test_df[features]), columns=features)
    
    # Add location ID column to scaled features for sequence creation
    X_train_scaled['location_id'] = train_df['location_id'].values
    X_test_scaled['location_id'] = test_df['location_id'].values

    TIME_STEPS = 3
    X_train_seq, y_train_seq = create_sequences(X_train_scaled, train_df[target], TIME_STEPS)
    X_test_seq, y_test_seq = create_sequences(X_test_scaled, test_df[target], TIME_STEPS)

    # Separate categorical feature (location_id) for embedding and numeric features
    loc_idx = X_train_scaled.columns.get_loc('location_id')
    
    X_train_loc = X_train_seq[:, :, loc_idx]
    X_train_num = np.delete(X_train_seq, loc_idx, axis=2)
    
    X_test_loc = X_test_seq[:, :, loc_idx]
    X_test_num = np.delete(X_test_seq, loc_idx, axis=2)

    print("Training GRU Model...")
    
    # Model architecture
    input_num = tf.keras.layers.Input(shape=(TIME_STEPS, X_train_num.shape[2]), name='numeric_input')
    input_loc = tf.keras.layers.Input(shape=(TIME_STEPS,), name='location_input')
    
    # Embedding layer for location_id
    emb_loc = tf.keras.layers.Embedding(input_dim=num_exits, output_dim=4)(input_loc)
    
    # Concatenate numeric features and embedded location features
    concat = tf.keras.layers.Concatenate(axis=-1)([input_num, emb_loc])
    
    # GRU Layers
    gru_out = tf.keras.layers.GRU(32, activation='relu', return_sequences=True)(concat)
    gru_out = tf.keras.layers.GRU(16, activation='relu')(gru_out)
    
    # Output layer with softplus activation to ensure non-negative count predictions
    output = tf.keras.layers.Dense(1, activation='softplus')(gru_out)
    
    model = tf.keras.models.Model(inputs=[input_num, input_loc], outputs=output)
    
    model.compile(optimizer='adam', loss='mean_squared_error', metrics=['mae'])
    
    model.fit([X_train_num, X_train_loc], y_train_seq, epochs=10, batch_size=64, validation_split=0.1, verbose=1)

    y_pred = model.predict([X_test_num, X_test_loc]).flatten()

    mae = mean_absolute_error(y_test_seq, y_pred)
    y_pred_pd = [max(1e-6, p) for p in y_pred]
    poisson_dev = mean_poisson_deviance(y_test_seq, y_pred_pd)
    
    print(f"GRU MAE: {mae:.4f}, Poisson Deviance: {poisson_dev:.4f}")

    # Pad predictions to match test_df length (due to TIME_STEPS)
    padded_preds = [0] * TIME_STEPS + y_pred.tolist()
    
    # Save results
    results = {
        "model": "GRU",
        "MAE": float(mae),
        "Poisson_Deviance": float(poisson_dev),
        "predictions": [float(p) for p in padded_preds]
    }
    with open(os.path.join(OUTPUT_DIR, "model10_gru_results.json"), "w") as f:
        json.dump(results, f, indent=4)

    model.save(os.path.join(OUTPUT_DIR, "model10_gru.keras"))
    print("GRU training complete.")

if __name__ == "__main__":
    main()
