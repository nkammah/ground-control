import React from 'react';
import Relay from 'react-relay';
import {GroupCallInvitationCreationForm} from './GroupCallInvitationCreationForm'

export class GroupCallInvitationList extends React.Component {

  state = {
    isCreating: false
  }

  handleCreateCall = (event) => {
    this.setState({isCreating: true})
  }

  renderGroupCallInvitations() {
    return this.props.viewer.groupCallInvitationList.map(invitation =>
      <ul key={invitation.id}>
        {invitation.topic}
      </ul>
    );
  }

  render() {
    var callCreationComponent;
    if (!this.state.isCreating)
      callCreationComponent = <button onClick={this.handleCreateCall}>New Call</button>;
    else
      callCreationComponent = <GroupCallInvitationCreationForm />
    return (
      <div>
        {this.renderGroupCallInvitations()}
        {callCreationComponent}
      </div>
    );
  }
}

export const GroupCallInvitationListRelay = Relay.createContainer(GroupCallInvitationList, {
  fragments: {
    viewer: () => Relay.QL`
      fragment on Viewer {
        groupCallInvitationList {
          id,
          topic
        }
      }
    `,
  },
});
