#include "VBAPPanner.h"
#include <cmath>
#include <algorithm>
#include <limits>

//==============================================================================
// SpeakerLayout presets
//==============================================================================

SpeakerLayout SpeakerLayout::stereo()
{
    return { "Stereo", { { -30.0f, 0.0f }, { 30.0f, 0.0f } } };
}

SpeakerLayout SpeakerLayout::quad()
{
    return { "Quad", {
        { -45.0f, 0.0f },   // Front Left
        {  45.0f, 0.0f },   // Front Right
        { -135.0f, 0.0f },  // Rear Left
        {  135.0f, 0.0f }   // Rear Right
    }};
}

SpeakerLayout SpeakerLayout::surround51()
{
    // ITU-R BS.775: L(-30), R(+30), C(0), LFE(n/a), Ls(-110), Rs(+110)
    // LFE has no spatial position — placed at 0,0 as placeholder; VBAP gain
    // for LFE is handled separately (typically bass-managed, not panned).
    return { "5.1", {
        { -30.0f, 0.0f },   // L
        {  30.0f, 0.0f },   // R
        {   0.0f, 0.0f },   // C
        {   0.0f, 0.0f },   // LFE (placeholder)
        { -110.0f, 0.0f },  // Ls
        {  110.0f, 0.0f }   // Rs
    }};
}

SpeakerLayout SpeakerLayout::surround71()
{
    return { "7.1", {
        { -30.0f, 0.0f },   // L
        {  30.0f, 0.0f },   // R
        {   0.0f, 0.0f },   // C
        {   0.0f, 0.0f },   // LFE (placeholder)
        { -90.0f, 0.0f },   // Lss (side left)
        {  90.0f, 0.0f },   // Rss (side right)
        { -135.0f, 0.0f },  // Lrs (rear left)
        {  135.0f, 0.0f }   // Rrs (rear right)
    }};
}

SpeakerLayout SpeakerLayout::atmos714()
{
    // 7.1.4 Dolby Atmos bed: 7.1 base + 4 height speakers
    return { "7.1.4", {
        // Bed (ear level)
        { -30.0f, 0.0f },   // L
        {  30.0f, 0.0f },   // R
        {   0.0f, 0.0f },   // C
        {   0.0f, 0.0f },   // LFE (placeholder)
        { -90.0f, 0.0f },   // Lss
        {  90.0f, 0.0f },   // Rss
        { -135.0f, 0.0f },  // Lrs
        {  135.0f, 0.0f },  // Rrs
        // Height (elevated)
        { -45.0f, 45.0f },  // Top Front Left
        {  45.0f, 45.0f },  // Top Front Right
        { -135.0f, 45.0f }, // Top Rear Left
        {  135.0f, 45.0f }  // Top Rear Right
    }};
}

//==============================================================================
// VBAPPanner
//==============================================================================

VBAPPanner::VBAPPanner()
{
    setSpeakerLayout (SpeakerLayout::stereo());
}

void VBAPPanner::setSpeakerLayout (const SpeakerLayout& layout)
{
    currentLayout = layout;
    gains.resize (currentLayout.speakers.size(), 0.0f);

    // Determine if layout is 3D (any speaker has non-zero elevation)
    is3D = false;
    for (const auto& spk : currentLayout.speakers)
    {
        if (std::abs (spk.elevation) > 0.1f)
        {
            is3D = true;
            break;
        }
    }

    recalculateGains();
}

void VBAPPanner::setPanPosition (float azimuth, float elevation)
{
    sourceAzimuth = azimuth;
    sourceElevation = elevation;
    recalculateGains();
}

std::vector<float> VBAPPanner::getGains() const
{
    return gains;
}

void VBAPPanner::processBlock (const juce::AudioBuffer<float>& monoInput,
                               juce::AudioBuffer<float>& surroundOutput,
                               int numSamples)
{
    const int numSpeakers = getNumSpeakers();
    const int outChannels = surroundOutput.getNumChannels();
    const int channelsToProcess = juce::jmin (numSpeakers, outChannels);

    if (monoInput.getNumChannels() < 1 || numSamples <= 0)
        return;

    const float* monoData = monoInput.getReadPointer (0);

    for (int ch = 0; ch < channelsToProcess; ++ch)
    {
        if (gains[static_cast<size_t> (ch)] > 0.0f)
        {
            surroundOutput.addFrom (ch, 0, monoData, numSamples, gains[static_cast<size_t> (ch)]);
        }
    }
}

VBAPPanner::Vec3 VBAPPanner::sphericalToCartesian (float azimuthDeg, float elevationDeg)
{
    const float azRad = juce::degreesToRadians (azimuthDeg);
    const float elRad = juce::degreesToRadians (elevationDeg);
    return {
        std::cos (elRad) * std::sin (azRad),   // x: positive = right
        std::cos (elRad) * std::cos (azRad),   // y: positive = front
        std::sin (elRad)                        // z: positive = up
    };
}

void VBAPPanner::recalculateGains()
{
    // Clear all gains
    std::fill (gains.begin(), gains.end(), 0.0f);

    if (currentLayout.speakers.empty())
        return;

    if (is3D)
        calculate3DGains();
    else
        calculate2DGains();
}

//==============================================================================
// 2D VBAP: find the two speakers bracketing the source azimuth
//==============================================================================
void VBAPPanner::calculate2DGains()
{
    const int numSpeakers = getNumSpeakers();

    if (numSpeakers == 0)
        return;

    // Special case: single speaker gets all the gain
    if (numSpeakers == 1)
    {
        gains[0] = 1.0f;
        return;
    }

    // Build sorted index list by azimuth for the pair search.
    // We work with azimuths normalized to [0, 360).
    struct SpkEntry { int index; float azNorm; };
    std::vector<SpkEntry> sorted;
    sorted.reserve (static_cast<size_t> (numSpeakers));

    for (int i = 0; i < numSpeakers; ++i)
    {
        float az = currentLayout.speakers[static_cast<size_t> (i)].azimuth;
        // Normalize to [0, 360)
        az = std::fmod (az + 360.0f, 360.0f);
        sorted.push_back ({ i, az });
    }

    std::sort (sorted.begin(), sorted.end(),
               [] (const SpkEntry& a, const SpkEntry& b) { return a.azNorm < b.azNorm; });

    float srcAz = std::fmod (sourceAzimuth + 360.0f, 360.0f);

    // Find the pair of adjacent speakers (in sorted order) that bracket srcAz.
    // The list wraps around (last speaker to first speaker).
    int leftIdx  = -1;
    int rightIdx = -1;

    for (size_t i = 0; i < sorted.size(); ++i)
    {
        size_t next = (i + 1) % sorted.size();
        float azL = sorted[i].azNorm;
        float azR = sorted[next].azNorm;

        // Handle the wrap-around pair
        bool inArc = false;
        if (azR > azL)
            inArc = (srcAz >= azL && srcAz <= azR);
        else  // wrap-around
            inArc = (srcAz >= azL || srcAz <= azR);

        if (inArc)
        {
            leftIdx  = sorted[i].index;
            rightIdx = sorted[next].index;
            break;
        }
    }

    // Fallback: closest speaker
    if (leftIdx < 0 || rightIdx < 0)
    {
        float minDist = 999.0f;
        int closest = 0;
        for (int i = 0; i < numSpeakers; ++i)
        {
            float diff = std::abs (std::fmod (currentLayout.speakers[static_cast<size_t> (i)].azimuth - sourceAzimuth + 540.0f, 360.0f) - 180.0f);
            if (diff < minDist)
            {
                minDist = diff;
                closest = i;
            }
        }
        gains[static_cast<size_t> (closest)] = 1.0f;
        return;
    }

    // If both speakers are the same (e.g., only 1 unique position), full gain to it
    if (leftIdx == rightIdx)
    {
        gains[static_cast<size_t> (leftIdx)] = 1.0f;
        return;
    }

    // Compute gains proportional to angular proximity.
    // Use the VBAP vector-base approach for 2D: g = [g1 g2] such that
    // g * [spk1_vec; spk2_vec] = source_vec, then normalize ||g|| = 1.
    float azL = currentLayout.speakers[static_cast<size_t> (leftIdx)].azimuth;
    float azR = currentLayout.speakers[static_cast<size_t> (rightIdx)].azimuth;

    // Convert to radians for trig
    float azLRad  = juce::degreesToRadians (azL);
    float azRRad  = juce::degreesToRadians (azR);
    float srcRad  = juce::degreesToRadians (sourceAzimuth);

    // 2D unit vectors (x = sin(az), y = cos(az))
    float l1x = std::sin (azLRad),  l1y = std::cos (azLRad);
    float l2x = std::sin (azRRad),  l2y = std::cos (azRRad);
    float px  = std::sin (srcRad),  py  = std::cos (srcRad);

    // Invert 2x2 matrix [l1x l2x; l1y l2y]
    float det = l1x * l2y - l2x * l1y;

    if (std::abs (det) < 1e-8f)
    {
        // Degenerate: speakers at same position, split equally
        gains[static_cast<size_t> (leftIdx)]  = 0.707107f;
        gains[static_cast<size_t> (rightIdx)] = 0.707107f;
        return;
    }

    float invDet = 1.0f / det;
    float g1 = invDet * ( l2y * px - l2x * py);
    float g2 = invDet * (-l1y * px + l1x * py);

    // Clamp negative gains (source outside the pair — shouldn't happen
    // with correct pair selection, but safety net)
    g1 = juce::jmax (0.0f, g1);
    g2 = juce::jmax (0.0f, g2);

    // Power-normalize so total power is preserved
    float norm = std::sqrt (g1 * g1 + g2 * g2);
    if (norm > 1e-8f)
    {
        g1 /= norm;
        g2 /= norm;
    }

    gains[static_cast<size_t> (leftIdx)]  = g1;
    gains[static_cast<size_t> (rightIdx)] = g2;
}

//==============================================================================
// 3D VBAP: find enclosing speaker triplet and compute gains via inverse matrix
//==============================================================================
void VBAPPanner::calculate3DGains()
{
    const int numSpeakers = getNumSpeakers();

    if (numSpeakers < 3)
    {
        // Fall back to 2D for fewer than 3 speakers
        calculate2DGains();
        return;
    }

    Vec3 src = sphericalToCartesian (sourceAzimuth, sourceElevation);

    // Convert all speakers to Cartesian
    std::vector<Vec3> spkVecs;
    spkVecs.reserve (static_cast<size_t> (numSpeakers));
    for (const auto& spk : currentLayout.speakers)
        spkVecs.push_back (sphericalToCartesian (spk.azimuth, spk.elevation));

    // Brute-force search over all speaker triplets.
    // For typical surround layouts (<=12 speakers) this is fast enough.
    float bestNorm = std::numeric_limits<float>::max();
    int bestI = 0, bestJ = 1, bestK = 2;
    float bestG1 = 0.0f, bestG2 = 0.0f, bestG3 = 0.0f;
    bool found = false;

    for (int i = 0; i < numSpeakers - 2; ++i)
    {
        for (int j = i + 1; j < numSpeakers - 1; ++j)
        {
            for (int k = j + 1; k < numSpeakers; ++k)
            {
                const auto& v1 = spkVecs[static_cast<size_t> (i)];
                const auto& v2 = spkVecs[static_cast<size_t> (j)];
                const auto& v3 = spkVecs[static_cast<size_t> (k)];

                // 3x3 matrix inversion: M = [v1; v2; v3] (rows = speaker vecs)
                // g = src * M^-1
                // Compute determinant
                float det = v1.x * (v2.y * v3.z - v2.z * v3.y)
                          - v1.y * (v2.x * v3.z - v2.z * v3.x)
                          + v1.z * (v2.x * v3.y - v2.y * v3.x);

                if (std::abs (det) < 1e-6f)
                    continue;  // Degenerate triplet (coplanar through origin)

                float invDet = 1.0f / det;

                // Cofactor matrix transposed (adjugate), then multiply by src
                float g1 = invDet * (src.x * (v2.y * v3.z - v2.z * v3.y)
                                   + src.y * (v2.z * v3.x - v2.x * v3.z)
                                   + src.z * (v2.x * v3.y - v2.y * v3.x));

                float g2 = invDet * (src.x * (v3.y * v1.z - v3.z * v1.y)
                                   + src.y * (v3.z * v1.x - v3.x * v1.z)
                                   + src.z * (v3.x * v1.y - v3.y * v1.x));

                float g3 = invDet * (src.x * (v1.y * v2.z - v1.z * v2.y)
                                   + src.y * (v1.z * v2.x - v1.x * v2.z)
                                   + src.z * (v1.x * v2.y - v1.y * v2.x));

                // Valid triplet: all gains non-negative
                if (g1 >= -1e-4f && g2 >= -1e-4f && g3 >= -1e-4f)
                {
                    g1 = juce::jmax (0.0f, g1);
                    g2 = juce::jmax (0.0f, g2);
                    g3 = juce::jmax (0.0f, g3);

                    float norm = g1 * g1 + g2 * g2 + g3 * g3;
                    if (norm < bestNorm)
                    {
                        bestNorm = norm;
                        bestI = i; bestJ = j; bestK = k;
                        bestG1 = g1; bestG2 = g2; bestG3 = g3;
                        found = true;
                    }
                }
            }
        }
    }

    if (found)
    {
        // Power-normalize
        float norm = std::sqrt (bestG1 * bestG1 + bestG2 * bestG2 + bestG3 * bestG3);
        if (norm > 1e-8f)
        {
            bestG1 /= norm;
            bestG2 /= norm;
            bestG3 /= norm;
        }

        gains[static_cast<size_t> (bestI)] = bestG1;
        gains[static_cast<size_t> (bestJ)] = bestG2;
        gains[static_cast<size_t> (bestK)] = bestG3;
    }
    else
    {
        // Fallback: nearest speaker
        float maxDot = -999.0f;
        int nearest = 0;
        for (int i = 0; i < numSpeakers; ++i)
        {
            const auto& v = spkVecs[static_cast<size_t> (i)];
            float dot = src.x * v.x + src.y * v.y + src.z * v.z;
            if (dot > maxDot)
            {
                maxDot = dot;
                nearest = i;
            }
        }
        gains[static_cast<size_t> (nearest)] = 1.0f;
    }
}

//==============================================================================
// SurroundPannerProcessor
//==============================================================================

SurroundPannerProcessor::SurroundPannerProcessor()
    : AudioProcessor (BusesProperties()
                        .withInput ("Input", juce::AudioChannelSet::mono(), true)
                        .withOutput ("Output", juce::AudioChannelSet::create7point1point4(), true))
{
}

SurroundPannerProcessor::~SurroundPannerProcessor() = default;

void SurroundPannerProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused (sampleRate);
    monoBuffer.setSize (1, samplesPerBlock);
}

void SurroundPannerProcessor::releaseResources()
{
    monoBuffer.setSize (0, 0);
}

bool SurroundPannerProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    // Input: mono or stereo
    const auto& inSet = layouts.getMainInputChannelSet();
    if (inSet != juce::AudioChannelSet::mono() && inSet != juce::AudioChannelSet::stereo())
        return false;

    // Output: must have at least as many channels as our speaker layout
    const int numOutCh = layouts.getMainOutputChannelSet().size();
    if (numOutCh < panner.getNumSpeakers())
        return false;

    return true;
}

void SurroundPannerProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ignoreUnused (midi);

    const int numSamples = buffer.getNumSamples();
    const int numInChannels = buffer.getNumChannels();

    if (numSamples == 0 || numInChannels == 0)
        return;

    // Update panner position from atomic params
    panner.setPanPosition (azimuth.load(), elevation.load());

    // Ensure mono buffer is large enough
    if (monoBuffer.getNumSamples() < numSamples)
        monoBuffer.setSize (1, numSamples, false, false, true);

    // Downmix input to mono
    monoBuffer.clear();
    for (int ch = 0; ch < numInChannels; ++ch)
        monoBuffer.addFrom (0, 0, buffer, ch, 0, numSamples, 1.0f / static_cast<float> (numInChannels));

    // Apply spread: when spread > 0, reduce gain difference between speakers
    // by blending toward equal-power distribution
    const float spreadVal = spread.load();

    // Clear the output buffer and distribute via VBAP
    buffer.clear();

    if (spreadVal < 0.01f)
    {
        // No spread — pure VBAP
        panner.processBlock (monoBuffer, buffer, numSamples);
    }
    else
    {
        // Blend between VBAP gains and equal-power distribution
        auto vbapGains = panner.getGains();
        const int numSpeakers = panner.getNumSpeakers();
        const int outCh = buffer.getNumChannels();
        const int chCount = juce::jmin (numSpeakers, outCh);

        // Equal-power gain for uniform distribution
        const float equalGain = (numSpeakers > 0) ? (1.0f / std::sqrt (static_cast<float> (numSpeakers))) : 0.0f;

        const float* monoData = monoBuffer.getReadPointer (0);
        for (int ch = 0; ch < chCount; ++ch)
        {
            float g = vbapGains[static_cast<size_t> (ch)] * (1.0f - spreadVal) + equalGain * spreadVal;
            if (g > 0.0f)
                buffer.addFrom (ch, 0, monoData, numSamples, g);
        }
    }
}

juce::AudioProcessorEditor* SurroundPannerProcessor::createEditor()
{
    return nullptr;  // No GUI editor — controlled via frontend
}

bool SurroundPannerProcessor::hasEditor() const    { return false; }
const juce::String SurroundPannerProcessor::getName() const  { return "S13 Surround Panner"; }
bool SurroundPannerProcessor::acceptsMidi() const  { return false; }
bool SurroundPannerProcessor::producesMidi() const { return false; }
bool SurroundPannerProcessor::isMidiEffect() const { return false; }
double SurroundPannerProcessor::getTailLengthSeconds() const { return 0.0; }

int SurroundPannerProcessor::getNumPrograms()     { return 1; }
int SurroundPannerProcessor::getCurrentProgram()  { return 0; }
void SurroundPannerProcessor::setCurrentProgram (int index)  { juce::ignoreUnused (index); }
const juce::String SurroundPannerProcessor::getProgramName (int index)  { juce::ignoreUnused (index); return "Default"; }
void SurroundPannerProcessor::changeProgramName (int index, const juce::String& newName)  { juce::ignoreUnused (index, newName); }

void SurroundPannerProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    // Serialize azimuth, elevation, spread, and layout name
    juce::ValueTree state ("SurroundPanner");
    state.setProperty ("azimuth",   static_cast<double> (azimuth.load()),   nullptr);
    state.setProperty ("elevation", static_cast<double> (elevation.load()), nullptr);
    state.setProperty ("spread",    static_cast<double> (spread.load()),    nullptr);
    state.setProperty ("layout",    panner.getSpeakerLayout().name,         nullptr);

    juce::MemoryOutputStream stream (destData, false);
    state.writeToStream (stream);
}

void SurroundPannerProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto state = juce::ValueTree::readFromData (data, static_cast<size_t> (sizeInBytes));
    if (state.isValid())
    {
        azimuth.store   (static_cast<float> (state.getProperty ("azimuth",   0.0)));
        elevation.store (static_cast<float> (state.getProperty ("elevation", 0.0)));
        spread.store    (static_cast<float> (state.getProperty ("spread",    0.0)));

        // Restore layout by name
        juce::String layoutName = state.getProperty ("layout", "Stereo").toString();
        if (layoutName == "Quad")         panner.setSpeakerLayout (SpeakerLayout::quad());
        else if (layoutName == "5.1")     panner.setSpeakerLayout (SpeakerLayout::surround51());
        else if (layoutName == "7.1")     panner.setSpeakerLayout (SpeakerLayout::surround71());
        else if (layoutName == "7.1.4")   panner.setSpeakerLayout (SpeakerLayout::atmos714());
        else                              panner.setSpeakerLayout (SpeakerLayout::stereo());
    }
}

void SurroundPannerProcessor::setAzimuth (float degrees)
{
    azimuth.store (juce::jlimit (-180.0f, 180.0f, degrees));
}

void SurroundPannerProcessor::setElevation (float degrees)
{
    elevation.store (juce::jlimit (-90.0f, 90.0f, degrees));
}

void SurroundPannerProcessor::setSpread (float value)
{
    spread.store (juce::jlimit (0.0f, 1.0f, value));
}
