import os
import sys
from pathlib import Path

# Test clients use this deterministic credential. Override inherited runtime/CI
# values before importing the app so the suite remains hermetic when the
# canonical gate injects production-shaped service credentials.
os.environ["BOREALIS_SERVICE_TOKEN"] = "borealis-test-service-token-that-is-long-enough"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
