#!/bin/bash
# quick-quantized-setup.sh — Verify quantized AI is running correctly
# Run this anytime to check that your local quantized models are working

echo "=== Quantized AI Setup Verification ==="
echo ""

# Check 1: Ollana is running
echo "1. Checking Ollama service..."
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "   ✅ Ollama is running"
    MODELS=$(curl -s http://localhost:11434/api/tags | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.models.map(m=>m.name).filter(n=>n.includes('qwen2.5')).join(', '))")
    echo "   Quantized models: $MODELS"
else
    echo "   ❌ Ollama is not running — start it with: ollama serve"
    exit 1
fi
echo ""

# Check 2: Fortress Hub is running
echo "2. Checking Fortress Hub..."
if curl -s http://localhost:4002/health > /dev/null 2>&1; then
    echo "   ✅ Fortress Hub is running at http://localhost:4002"
    echo "   Settlement endpoint: http://localhost:4002/api/settlement/team"
else
    echo "   ❌ Fortress Hub is not running — start it with: npm run dev"
fi
echo ""

# Check 3: Test quantized model
echo "3. Testing quantized model (qwen2.5:0.5b)..."
RESPONSE=$(curl -s -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5:0.5b",
    "messages": [{"role": "user", "content": "Say a short hello"}],
    "max_tokens": 30
  }')
if echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);process.exit(j.choices && j.choices.length>0 ? 0 : 1)" 2>/dev/null; then
    REPLY=$(echo "$RESPONSE" | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');const j=JSON.parse(d);console.log(j.choices[0].message.content.trim())")
    echo "   ✅ Model working"
    echo "   Test reply: $REPLY"
else
    echo "   ❌ Model test failed"
fi
echo ""

# Check 4: Moltis config
echo "4. Checking Moltis config..."
MOLTIS_CONFIG="/Users/tfe/.config/moltis/moltis.toml"
if [ -f "$MOLTIS_CONFIG" ]; then
    OLLAMA_PRIMARY=$(grep -c 'ollama.*qwen2.5' "$MOLTIS_CONFIG" || echo 0)
    echo "   ✅ Moltis config found at $MOLTIS_CONFIG"
    echo "   Quantized model references found: $OLLAMA_PRIMARY"
else
    echo "   ❌ Moltis config not found — run install.sh"
fi
echo ""

# Check 5: OpenChamber extension config
echo "5. Checking OpenChamber extension config..."
OPENCODE_CONFIG="/Users/tfe/.config/opencode/opencode.json"
if [ -f "$OPENCODE_CONFIG" ]; then
    node -e "
      const c = require('$OPENCODE_CONFIG');
      const prov = (c.provider || {}).ollama;
      if (!prov) { console.error('   ❌ No ollama provider defined'); process.exit(1); }
      console.log('   ✅ OpenChamber config found at $OPENCODE_CONFIG');
      console.log('   Primary model:   ' + c.model);
      console.log('   Small model:     ' + c.small_model);
      console.log('   Ollama provider: ' + (prov.options && prov.options.baseURL));
      console.log('   Local models:    ' + Object.keys(prov.models || {}).join(', '));
    " || echo "   ❌ OpenChamber config missing ollama provider — check $OPENCODE_CONFIG"
else
    echo "   ❌ OpenChamber config not found"
fi
echo ""

# Check 6: End-to-end test through opencode (OpenChamber's engine)
echo "6. Testing quantized model through opencode..."
OPCODE_BIN="/Users/tfe/.opencode/bin/opencode"
if [ -x "$OPCODE_BIN" ]; then
    REPLY=$("$OPCODE_BIN" run --model ollama/qwen2.5:1.5b "Reply with exactly: LOCAL_OK" 2>/dev/null | tail -3)
    if echo "$REPLY" | grep -q "LOCAL_OK"; then
        echo "   ✅ opencode → ollama/qwen2.5:1.5b round-trip successful"
        echo "   Reply: $REPLY"
    else
        echo "   ⚠️  opencode ran but reply unexpected:"
        echo "   $REPLY"
    fi
else
    echo "   ⚠️  opencode binary not found at $OPCODE_BIN (OpenChamber won't work)"
fi
echo ""

echo "=== Setup Complete ==="
echo "Your M1 Mac is now running quantized AI models locally."
echo "No cloud API calls unless local models fail."
echo ""