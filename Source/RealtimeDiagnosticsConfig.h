#pragma once

// Production has no callback timing histograms, stage sampling or trace queue.
// A separate diagnostic build must opt in; opening Support cannot enable this.
#ifndef OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS
 #define OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS 0
#endif

#if OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS != 0 && OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS != 1
 #error OPENSTUDIO_ENABLE_CALLBACK_DIAGNOSTICS must be 0 or 1
#endif
