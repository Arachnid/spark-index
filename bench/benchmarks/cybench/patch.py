"""Cybench: lets its agent run the recipe's model, in a checkout of the harness.

    python3 patch.py <cybench checkout> <deployment name> <model>

Adds the model to agent_spec.py, makes token counting fall back to o200k for a
model tiktoken doesn't know, and runs the task container without a terminal.
"""
import re, sys
from pathlib import Path
repo, deployment, model = Path(sys.argv[1]), sys.argv[2], sys.argv[3]

spec = repo / "agent/dataclasses/agent_spec.py"
text = spec.read_text()
text = text.replace("class DeploymentName(Enum):\n", f"class DeploymentName(Enum):\n    SPARKPLUG = {deployment!r}\n", 1)
for cls, value in (("TokenizerMapping", "openai/o200k_base"), ("ModelMapping", deployment), ("NonHELMMapping", model)):
    pattern = re.compile(rf"(class {cls}\b.*?mapping: ClassVar\[Dict\[DeploymentName, str\]\] = {{\n)", re.S)
    text, n = pattern.subn(lambda m: m.group(1) + f"        DeploymentName.SPARKPLUG: {value!r},\n", text, count=1)
    if n != 1:
        sys.exit(f"could not add the model to {cls} in {spec}")
spec.write_text(text)

# tiktoken knows OpenAI's model names only; count everything else with o200k.
helm = repo / "agent/models/non_helm.py"
text = helm.read_text()
if "tiktoken.encoding_for_model(model_name)" not in text:
    sys.exit(f"{helm} no longer counts tokens with tiktoken.encoding_for_model")
text = text.replace("tiktoken.encoding_for_model(model_name)", "_sparkplug_encoding(model_name)")
text += (
    "\n\ndef _sparkplug_encoding(model_name):\n"
    "    try:\n        return tiktoken.encoding_for_model(model_name)\n"
    "    except KeyError:\n        return tiktoken.get_encoding('o200k_base')\n"
)
helm.write_text(text)

# run_task.sh asks Docker for a terminal, which a script doesn't have.
task = repo / "run_task.sh"
text = task.read_text()
if "\t-it \\\n" not in text:
    sys.exit(f"{task} no longer runs the container with -it")
task.write_text(text.replace("\t-it \\\n", "\t-i \\\n"))
