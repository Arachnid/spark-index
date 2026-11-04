# Mia's AI Lab's Qwen3.8 27B on SGLang, one Spark.
# https://github.com/MiaAI-Lab/Qwen3.8-27B-SGLang-DGX-Spark

need_cmd git docker
clone_or_update https://github.com/MiaAI-Lab/Qwen3.8-27B-SGLang-DGX-Spark.git recipe
cd recipe
[ -f .env ] || cp .env.sample .env
docker pull lmsysorg/sglang:qwen38-27b
