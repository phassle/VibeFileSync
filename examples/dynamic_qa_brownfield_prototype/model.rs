#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stage {
    SetupInventory,
    FlowContract,
    CandidateBinding,
    AdvisoryCi,
    DeterministicFailure,
    Diagnosis,
    RepairReview,
    Reaction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Advance,
    Fail,
    Diagnose,
    ProposeRepair,
    Accept,
    Edit,
    Reject,
    Reset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepairDecision {
    AcceptedUnchanged,
    NeedsEdit,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrototypeState {
    pub stage: Stage,
    pub failure_reproductions: u8,
    pub repair_decision: Option<RepairDecision>,
}

impl Default for PrototypeState {
    fn default() -> Self {
        Self {
            stage: Stage::SetupInventory,
            failure_reproductions: 0,
            repair_decision: None,
        }
    }
}

impl PrototypeState {
    pub fn apply(&self, action: Action) -> Result<Self, &'static str> {
        if action == Action::Reset {
            return Ok(Self::default());
        }

        let mut next = self.clone();
        match (self.stage, action) {
            (Stage::SetupInventory, Action::Advance) => next.stage = Stage::FlowContract,
            (Stage::FlowContract, Action::Advance) => next.stage = Stage::CandidateBinding,
            (Stage::CandidateBinding, Action::Advance) => next.stage = Stage::AdvisoryCi,
            (Stage::AdvisoryCi, Action::Fail) => {
                next.stage = Stage::DeterministicFailure;
                next.failure_reproductions = 3;
            }
            (Stage::DeterministicFailure, Action::Diagnose) => next.stage = Stage::Diagnosis,
            (Stage::Diagnosis, Action::ProposeRepair) => next.stage = Stage::RepairReview,
            (Stage::RepairReview, Action::Accept) => {
                next.stage = Stage::Reaction;
                next.repair_decision = Some(RepairDecision::AcceptedUnchanged);
            }
            (Stage::RepairReview, Action::Edit) => {
                next.stage = Stage::Reaction;
                next.repair_decision = Some(RepairDecision::NeedsEdit);
            }
            (Stage::RepairReview, Action::Reject) => {
                next.stage = Stage::Reaction;
                next.repair_decision = Some(RepairDecision::Rejected);
            }
            _ => return Err("that action is unavailable at this stage"),
        }
        Ok(next)
    }
}
