# DSpark speculative decoding, the recipe's fastest mode. Speculative decoding
# doesn't change the model's outputs, so the score holds for the other modes.
cd recipe
run_detached server ./start-dspark.sh
