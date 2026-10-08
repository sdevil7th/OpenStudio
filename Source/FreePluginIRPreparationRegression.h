#pragma once
inline juce::var checkIRPreparationCancellation()
{
    auto* result=new juce::DynamicObject();result->setProperty("plugin","Cancellable staged IR preparation");
    BuiltInConvolution convolution;convolution.selectDefault();convolution.prepare(48000,127);
    const auto snapshot=[&](){juce::ValueTree tree("IR");convolution.save(tree);juce::MemoryBlock bytes;juce::MemoryOutputStream out(bytes,false);tree.writeToStream(out);out.flush();return bytes;};
    const auto before=snapshot();BuiltInIRPreparation stopped;const bool cancelled=stopped.cancel();const bool rejected=!convolution.selectDefault(&stopped)&&snapshot()==before&&!stopped.publish();stopped.finish(false);
    BuiltInIRPreparation success;const bool prepared=convolution.selectDefault(&success);const bool finalStage=success.info()["state"].toString()=="publishing"&&static_cast<int>(success.info()["stage"])==BuiltInIRPreparation::finalising&&!success.cancel();success.finish(prepared);
    bool publicationRace=true;for(int i=0;i<64;++i)
    {
        BuiltInIRPreparation ticket;bool published=false,didCancel=false;
        std::thread publisher([&]{published=ticket.publish();});std::thread canceller([&]{didCancel=ticket.cancel();});publisher.join();canceller.join();publicationRace=publicationRace&&(published!=didCancel);ticket.finish(published);
    }
    // Cancel a real size conversion while it runs. All metadata remains on the
    // old response until the final atomic publication claim.
    BuiltInIRPreparation active;juce::DynamicObject::Ptr edit=new juce::DynamicObject();edit->setProperty("size",2.0);std::atomic<bool> done{false};bool applied=true;
    std::thread worker([&]{applied=convolution.edit(juce::var(edit.get()),&active);active.finish(applied);done.store(true);});
    const auto deadline=juce::Time::getMillisecondCounter()+5000;bool duringShape=false;
    while(!done.load()&&juce::Time::getMillisecondCounter()<deadline)
    {
        if(static_cast<int>(active.info()["stage"])==BuiltInIRPreparation::shaping){duringShape=active.cancel();break;}
        std::this_thread::yield();
    }
    worker.join();const bool retained=duringShape&&!applied&&snapshot()==before&&active.info()["state"].toString()=="cancelled";
    const bool states=cancelled&&rejected&&prepared&&finalStage&&success.terminal()&&success.info()["state"].toString()=="complete"&&stopped.terminal();
    result->setProperty("pass",states&&publicationRace&&retained);result->setProperty("preCancelledRetainsState",rejected);result->setProperty("preparedStagesAndTerminalStates",states);result->setProperty("cancelPublicationSingleWinner",publicationRace);result->setProperty("cancelDuringShapingRetainsExactState",retained);result->setProperty("cancellationLatency","stage_boundaries; JUCE kernel preparation is not interrupted internally");result->setProperty("audioQuality","not_asserted");return result;
}
